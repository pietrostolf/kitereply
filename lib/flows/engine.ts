import { createHash } from "node:crypto";
import { reserveWorkspaceDMSend } from "@/lib/billing/usage";
import { prisma } from "@/lib/db/client";
import { RateLimitError, sendMessage } from "@/lib/meta/client";
import { createInstagramContext, type InstagramContext } from "@/lib/instagram/context";
import { getDMQueue, getRedisConnection, FLOW_REMINDER_JOB_NAME, GIFT_RETRY_JOB_NAME } from "@/lib/queue/client";
import { graphemes } from "@/lib/flows/templates";
import { FLOW_LINK_POSITION } from "@/lib/tracking/link-order";
import { buildTrackedUrl } from "@/lib/tracking/message";
import { generateTrackedLinkSlug, hashRecipientId } from "@/lib/tracking/server";
import { reserveDMSlot } from "@/lib/utils/rate-limiter";

/**
 * Multi-step DM flows (the ManyChat replacement). A flow is a list of steps
 * stored as JSON on Automation.flow; payloads `flow:<automationId>:<stepId>[~r]:<button>`
 * carry taps back here (`~r` = a reminder's button). Meta allows one private
 * reply per comment, so a flow only continues after the person taps or types:
 * the start step must ask something (buttons or a question).
 *
 * Every handler takes an `opId` (the inbound comment/postback/message id) so a
 * retried job skips messages it already delivered instead of sending twice.
 */

export type FlowButton = {
  title: string;
  /** Step to run when tapped (postback / quick reply). */
  next?: string;
  /** Opens a link instead (tracked, so reminders can tell it was clicked). */
  url?: string;
  /** Tags added to the contact when tapped. */
  tags?: string[];
};

export type FlowStep = {
  id: string;
  text: string;
  /** Up to 3 → button template; more → quick replies (no links there). */
  buttons?: FlowButton[];
  /** Tags added to the contact when this step is sent. */
  tags?: string[];
  /** Wait for a typed answer, store it, then run `next`. */
  ask?: "email" | "phone";
  /** Sent when the typed answer doesn't look valid (max 2 retries). */
  invalidText?: string;
  /** Quick reply that skips the question and runs `next`. */
  skipLabel?: string;
  /** Promotion slug: invite the contact's email on the platform, then run
   *  `existing` if they already had an account, else `next`. */
  gift?: string;
  existing?: string;
  /** Run right after this one (only after the person has interacted). */
  next?: string;
  /** Sent `hours` later (max 23, inside Meta's 24h window) only if no link of
   *  this flow was clicked. */
  reminder?: { hours: number; text: string; buttons?: FlowButton[] };
  /** Hands the conversation to a human: DM automations stay quiet for 24h. */
  handoff?: boolean;
};

export type Flow = { start: string; steps: FlowStep[] };

type FlowAutomation = {
  id: string;
  workspaceId: string;
  flow: unknown;
  instagramAccount: { instagramId: string; id: string };
};

type MetaContext = Extract<InstagramContext, { provider: "META" }>;

export type Recipient = { commentId: string } | { userId: string };

const WAIT_TTL_SECONDS = 24 * 60 * 60; // Meta's messaging window
const SENT_TTL_SECONDS = 7 * 24 * 60 * 60; // longer than any job retry
const REMINDER_SUFFIX = "~r";
const waitKey = (igId: string, userId: string) => `flow_wait:${igId}:${userId}`;
const humanKey = (igId: string, userId: string) => `flow_human:${igId}:${userId}`;

/** True while a person asked to talk to a human (other DM automations stay quiet). */
export async function isWithHuman(igId: string, userId: string) {
  return (await getRedisConnection().exists(humanKey(igId, userId))) > 0;
}
const opHash = (opId: string) => createHash("sha256").update(opId).digest("hex").slice(0, 24);

export function getFlow(automation: { flow: unknown }): Flow | null {
  const flow = automation.flow as Flow | null;
  return flow && Array.isArray(flow.steps) && flow.start ? flow : null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizeAnswer(ask: "email" | "phone", text: string): string | null {
  const t = text.trim();
  if (ask === "email") {
    const e = t.toLowerCase().replace(/\s+/g, "");
    return EMAIL_RE.test(e) ? e : null;
  }
  const digits = t.replace(/[^\d+]/g, "");
  return digits.replace(/\D/g, "").length >= 10 ? digits : null;
}

/** A message that is clearly not an attempt to answer (a question, a sentence). */
function looksLikeOtherMessage(ask: "email" | "phone", text: string) {
  const t = text.trim();
  return ask === "email" ? !t.includes("@") && t.split(/\s+/).length > 3 : !/\d/.test(t);
}

async function upsertContact(
  workspaceId: string,
  igsid: string,
  data: { username?: string | null; tags?: string[]; email?: string; phone?: string; consent?: boolean }
) {
  const where = { workspaceId_igsid: { workspaceId, igsid } };
  const existing = await prisma.contact.findUnique({ where });
  const fields = {
    ...(data.username ? { username: data.username } : {}),
    ...(data.email ? { email: data.email } : {}),
    ...(data.phone ? { phone: data.phone } : {}),
    ...(data.consent && !existing?.consentAt ? { consentAt: new Date() } : {}),
    tags: [...new Set([...(existing?.tags ?? []), ...(data.tags ?? [])])],
  };
  // upsert, not find-then-create: two jobs for the same new person may race.
  return prisma.contact.upsert({ where, create: { workspaceId, igsid, ...fields }, update: fields });
}

async function trackedUrl(automation: FlowAutomation, url: string, userId: string) {
  let link = await prisma.trackedLink.findFirst({
    where: { automationId: automation.id, destinationUrl: url, position: FLOW_LINK_POSITION },
  });
  link ??= await prisma.trackedLink.create({
    data: {
      workspaceId: automation.workspaceId,
      automationId: automation.id,
      slug: generateTrackedLinkSlug(),
      destinationUrl: url,
      position: FLOW_LINK_POSITION, // kept apart from the campaign's own links
    },
  });
  return buildTrackedUrl(link.slug, undefined, hashRecipientId(userId));
}

/** Build the Messenger-format message for a step's text and buttons. */
export async function buildMessage(
  automation: FlowAutomation,
  payloadStepId: string,
  text: string,
  buttons: FlowButton[] | undefined,
  userId: string,
  skipLabel?: string
): Promise<Record<string, unknown>> {
  const payload = (i: number | "skip") => `flow:${automation.id}:${payloadStepId}:${i}`;
  const list = buttons ?? [];
  if (list.some((b) => b.url) && (list.length > 3 || skipLabel)) {
    // Quick replies can't open links; fail loudly instead of sending dead buttons.
    throw new Error(`Flow step "${payloadStepId}": links need 3 buttons or fewer and no skip option`);
  }
  if (list.length > 0 && list.length <= 3 && !skipLabel) {
    return {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: text.slice(0, 640),
          buttons: await Promise.all(
            list.map(async (b, i) =>
              b.url
                ? { type: "web_url", title: cut(b.title, 20), url: await trackedUrl(automation, b.url, userId) }
                : { type: "postback", title: cut(b.title, 20), payload: payload(i) }
            )
          ),
        },
      },
    };
  }
  const quick = list
    .slice(0, skipLabel ? 12 : 13)
    .map((b, i) => ({ content_type: "text", title: cut(b.title, 20), payload: payload(i) }));
  if (skipLabel) quick.push({ content_type: "text", title: cut(skipLabel, 20), payload: payload("skip") });
  return quick.length ? { text: text.slice(0, 1000), quick_replies: quick } : { text: text.slice(0, 1000) };
}

type RunArgs = {
  context: InstagramContext;
  automation: FlowAutomation;
  recipient: Recipient;
  userId: string;
  username?: string | null;
  stepId: string;
  /** Inbound event id: makes retries skip what was already sent. */
  opId: string;
  /** Guards against a step chain that loops. */
  depth?: number;
};

/**
 * Send `message` once per (opId, key). Returns false when a previous attempt
 * of the same job already delivered it.
 */
async function sendOnce(
  context: MetaContext,
  automation: FlowAutomation,
  recipient: Recipient,
  opId: string,
  key: string,
  message: Record<string, unknown>
): Promise<boolean> {
  const redis = getRedisConnection();
  const sentKey = `flow_sent:${opHash(opId)}:${key}`;
  if (await redis.exists(sentKey)) return false;
  // The comment path already reserved quota and rate limit for its private reply.
  if (!("commentId" in recipient)) {
    const igId = automation.instagramAccount.instagramId;
    const slot = await reserveDMSlot(igId);
    const usage = await reserveWorkspaceDMSend(automation.workspaceId);
    if (!slot.allowed || !usage.allowed)
      throw new RateLimitError(`Flow DM limit reached for ${igId}`, undefined, undefined, 4);
  }
  await sendMessage(context, automation.instagramAccount.instagramId, toMetaRecipient(recipient), message);
  await redis.set(sentKey, "1", "EX", SENT_TTL_SECONDS);
  return true;
}

/** After the message is out, a failing side effect must not make the send look failed. */
async function sideEffect(automation: FlowAutomation, what: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (error) {
    await prisma.operationalEvent
      .create({
        data: {
          workspaceId: automation.workspaceId,
          source: "WORKER",
          level: "WARNING",
          message: `Fluxo: ${what} falhou depois do envio`,
          payload: { automationId: automation.id, error: String(error) },
        },
      })
      .catch(() => undefined);
  }
}

/**
 * Run one step (and the steps chained after it). Throws on a misconfigured
 * flow so the caller records a failure instead of a false "sent".
 */
export async function runStep(args: RunArgs): Promise<void> {
  const { context, automation, recipient, userId, username, opId } = args;
  const depth = args.depth ?? 0;
  const step = getFlow(automation)?.steps.find((s) => s.id === args.stepId);
  if (!step) throw new Error(`Flow step "${args.stepId}" not found in campaign ${automation.id}`);
  if (depth > 10) throw new Error(`Flow ${automation.id} loops through more than 10 steps`);
  if (context.provider !== "META") throw new Error("Flows need a Meta-connected account"); // shortcut: Zernio not wired, add when a Zernio account needs flows

  const igId = automation.instagramAccount.instagramId;
  const contact = await upsertContact(automation.workspaceId, userId, { username, tags: step.tags });

  if (step.gift) {
    const redis = getRedisConnection();
    const giftKey = `flow_gift:${opHash(opId)}:${step.id}`;
    const result =
      ((await redis.get(giftKey)) as GiftResult | null) ??
      (contact.email ? await claimGift(step.gift, contact.email, contact.username) : "error");
    if (result !== "error" && result !== "retry") await redis.set(giftKey, result, "EX", SENT_TTL_SECONDS);
    if (result === "ended") {
      await sendOnce(context, automation, recipient, opId, `${step.id}:ended`, {
        text: "Poxa, esse presente era por tempo limitado e já encerrou 😕 Mas fica de olho que sempre tem novidade por aqui! 🎒",
      });
      return;
    }
    if (result === "error" || result === "retry") {
      // Never tell someone to check their email when no invite went out.
      if (result === "retry") await scheduleGiftRetry(automation, step.id, userId, 1, opId);
      else await giftFailed(automation, step.gift, contact.username ?? userId, userId, contact.email);
      await sendOnce(context, automation, recipient, opId, `${step.id}:gifterr`, {
        text: "Recebi seu e-mail! 🎒 O presente vai chegar em algumas horas, tá? Se tiver qualquer dúvida, é só mandar aqui.",
      });
      return;
    }
    if (step.text)
      await sendOnce(context, automation, recipient, opId, step.id, { text: render(step.text, username).slice(0, 1000) });
    const nextId = result === "existing" ? step.existing ?? step.next : step.next;
    if (nextId) await runStep({ ...args, stepId: nextId, depth: depth + 1 });
    return;
  }

  const message = await buildMessage(automation, step.id, render(step.text, username), step.buttons, userId, step.ask ? step.skipLabel : undefined);
  const sentNow = await sendOnce(context, automation, recipient, opId, step.id, message);

  if (step.ask) {
    await sideEffect(automation, "guardar a pergunta pendente", () =>
      getRedisConnection().set(
        waitKey(igId, userId),
        JSON.stringify({ automationId: automation.id, stepId: step.id, tries: 0 }),
        "EX",
        WAIT_TTL_SECONDS
      )
    );
  }
  if (step.handoff) {
    await sideEffect(automation, "pausar as automações para a conversa humana", () =>
      getRedisConnection().set(humanKey(igId, userId), "1", "EX", WAIT_TTL_SECONDS)
    );
  }
  if (step.reminder && sentNow) {
    const hours = Math.min(step.reminder.hours, 23);
    await sideEffect(automation, "agendar o lembrete", () =>
      getDMQueue().add(
        FLOW_REMINDER_JOB_NAME,
        { instagramAccountId: igId, accountConnectionId: automation.instagramAccount.id, userId, automationId: automation.id, stepId: step.id },
        // Unique per delivery: a fixed id would be ignored while BullMQ keeps the last run.
        { delay: hours * 3600_000, jobId: `flowrem_${opHash(opId)}_${opHash(step.id)}` }
      )
    );
  }
  // A private reply can't be followed by more messages until the person answers.
  if (step.next && !step.ask && !step.buttons?.length && !("commentId" in recipient)) {
    await runStep({ ...args, recipient: { userId }, stepId: step.next, depth: depth + 1 });
  }
}

/** Handle a flow button tap (postback or quick reply payload). Returns false if not a flow payload. */
export async function handleFlowPayload(userId: string, payload: string, igId: string, opId: string): Promise<boolean> {
  if (!payload.startsWith("flow:")) return false;
  const [, automationId, rawStepId = "", choice] = payload.split(":");
  const fromReminder = rawStepId.endsWith(REMINDER_SUFFIX);
  const stepId = fromReminder ? rawStepId.slice(0, -REMINDER_SUFFIX.length) : rawStepId;
  const automation = await prisma.automation.findFirst({
    where: { id: automationId, isActive: true },
    include: { instagramAccount: true },
  });
  const step = automation && getFlow(automation)?.steps.find((s) => s.id === stepId);
  // The payload comes from the user's tap: only act on this account's own flows.
  if (!automation || !step || automation.instagramAccount.instagramId !== igId) return true;

  const base = { context: await createInstagramContext(automation.instagramAccount), userId, opId };
  if (choice === "skip") {
    await getRedisConnection().del(waitKey(igId, userId));
    if (step.next) await runStep({ ...base, automation, recipient: { userId }, stepId: step.next });
    return true;
  }
  const button = (fromReminder ? step.reminder?.buttons : step.buttons)?.[Number(choice)];
  if (!button) return true;
  if (button.tags?.length) await upsertContact(automation.workspaceId, userId, { tags: button.tags });
  if (button.next) await runStep({ ...base, automation, recipient: { userId }, stepId: button.next });
  return true;
}

/** Handle a typed DM while a flow waits for an answer. Returns false if nothing was waiting. */
export async function handleFlowAnswer(userId: string, igId: string, text: string, opId: string): Promise<boolean> {
  const redis = getRedisConnection();
  const key = waitKey(igId, userId);
  const raw = await redis.get(key);
  if (!raw) return false;
  const wait = JSON.parse(raw) as { automationId: string; stepId: string; tries: number };
  const automation = await prisma.automation.findFirst({
    where: { id: wait.automationId, isActive: true },
    include: { instagramAccount: true },
  });
  const step = automation && getFlow(automation)?.steps.find((s) => s.id === wait.stepId);
  if (!automation || !step?.ask) {
    await redis.del(key);
    return false;
  }
  // A question or comment from the person goes to the normal handling (keyword campaigns, a human).
  if (looksLikeOtherMessage(step.ask, text)) return false;
  const context = await createInstagramContext(automation.instagramAccount);
  if (context.provider !== "META") return false;

  const value = normalizeAnswer(step.ask, text);
  if (!value) {
    if (wait.tries >= 2) {
      await redis.del(key);
      return false;
    }
    await redis.set(key, JSON.stringify({ ...wait, tries: wait.tries + 1 }), "EX", WAIT_TTL_SECONDS);
    const retry = step.invalidText ?? (step.ask === "email" ? "Hmm, esse e-mail não parece certo. Pode mandar de novo?" : "Hmm, esse número não parece certo. Manda com DDD, por favor?");
    const message = await buildMessage(automation, step.id, retry, undefined, userId, step.skipLabel);
    await sendOnce(context, automation, { userId }, opId, `${step.id}:retry`, message);
    return true;
  }

  await upsertContact(automation.workspaceId, userId, step.ask === "email" ? { email: value, consent: true } : { phone: value });
  if (step.next) await runStep({ context, automation, recipient: { userId }, userId, opId, stepId: step.next });
  // Cleared only after the next steps ran, so a retried job still finds it; and
  // only if those steps didn't already store a new question under the same key.
  if ((await redis.get(key)) === raw) await redis.del(key);
  return true;
}

/** Delayed reminder: send only if none of this flow's links was clicked by the person. */
export async function sendFlowReminder(automationId: string, stepId: string, userId: string, opId: string) {
  const automation = await prisma.automation.findFirst({
    where: { id: automationId, isActive: true },
    include: { instagramAccount: true },
  });
  const step = automation && getFlow(automation)?.steps.find((s) => s.id === stepId);
  if (!automation || !step?.reminder) return;
  const context = await createInstagramContext(automation.instagramAccount);
  if (context.provider !== "META") return;
  const clicked = await prisma.linkClick.count({
    where: { automationId, recipientHash: hashRecipientId(userId) },
  });
  if (clicked > 0) return;
  // Several steps of one flow can schedule a reminder; a person gets at most one a day.
  const once = await getRedisConnection().set(`flow_reminded:${automationId}:${userId}`, "1", "EX", WAIT_TTL_SECONDS, "NX");
  if (!once) return;
  const contact = await prisma.contact.findUnique({
    where: { workspaceId_igsid: { workspaceId: automation.workspaceId, igsid: userId } },
  });
  const message = await buildMessage(automation, `${stepId}${REMINDER_SUFFIX}`, render(step.reminder.text, contact?.username), step.reminder.buttons, userId);
  await sendOnce(context, automation, { userId }, opId, `${stepId}${REMINDER_SUFFIX}`, message);
}

/** Truncate by visible characters, so an emoji (even a flag) is never split. */
function cut(text: string, max: number) {
  return graphemes(text).slice(0, max).join("");
}

function render(text: string, username?: string | null) {
  return text.replace(/\{username\}/g, username ?? "");
}

function toMetaRecipient(r: Recipient) {
  return "commentId" in r ? { comment_id: r.commentId } : { id: r.userId };
}

type GiftResult = "invited" | "existing" | "ended" | "retry" | "error";

/** Retries a held-back gift every 30 min for 3 h, well inside the 24 h messaging window. */
const GIFT_RETRY_DELAY_MS = 30 * 60_000;
const GIFT_MAX_ATTEMPTS = 6;

/**
 * Ask the community platform to invite the email to a promotion.
 * "retry" = it may work later (hourly cap, e-mail limit, outage); "error" = a
 * human has to look (bad config, abuse cap). The endpoint is the platform's
 * gift function (GIFT_ENDPOINT_URL), authenticated with a shared secret.
 */
async function claimGift(promo: string, email: string, instagram: string | null): Promise<GiftResult> {
  const url = process.env.GIFT_ENDPOINT_URL;
  const secret = process.env.GIFT_ENDPOINT_SECRET;
  if (!url || !secret) return "error";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ promo, email, instagram }),
      // The platform answers in a few seconds; a short timeout would report a gift that did go out as failed.
      signal: AbortSignal.timeout(25_000),
    });
    const data = (await res.json().catch(() => ({}))) as { result?: string };
    if (data.result === "existing" || data.result === "ended") return data.result;
    if (res.ok && data.result === "invited") return "invited";
    return [429, 502, 503, 504].includes(res.status) ? "retry" : "error";
  } catch {
    // Timeout or network: the invite may or may not have gone out; the platform skips a resend within 24 h.
    return "retry";
  }
}

async function scheduleGiftRetry(automation: FlowAutomation, stepId: string, userId: string, attempt: number, opId: string) {
  await getDMQueue().add(
    GIFT_RETRY_JOB_NAME,
    {
      instagramAccountId: automation.instagramAccount.instagramId,
      accountConnectionId: automation.instagramAccount.id,
      userId,
      automationId: automation.id,
      stepId,
      attempt,
      opId,
    },
    { delay: GIFT_RETRY_DELAY_MS, jobId: `giftretry_${opHash(opId)}_${attempt}` }
  );
}

/** Gives up on a gift: records it and e-mails the owner, who releases it by hand. */
async function giftFailed(automation: FlowAutomation, promo: string, who: string, userId: string, email: string | null) {
  const message = `Presente "${promo}" não enviado para @${who}: liberar à mão`;
  await prisma.operationalEvent.create({
    data: {
      workspaceId: automation.workspaceId,
      source: "WORKER",
      level: "ERROR",
      message,
      payload: { automationId: automation.id, igsid: userId, email },
    },
  });
  await notifyOwner(message, `${message}\nE-mail informado: ${email ?? "(nenhum)"}\nA pessoa recebeu "o presente vai chegar em algumas horas".`);
}

/** E-mail to ALERT_EMAIL through Resend; silent when not configured. */
async function notifyOwner(subject: string, text: string) {
  const to = process.env.ALERT_EMAIL;
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!to || !key || !from) return;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject: `[KiteReply] ${subject}`, text }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
}

/** Delayed job: try a held-back gift again and, once it goes out, send the step that follows it. */
export async function retryGift(automationId: string, stepId: string, userId: string, attempt: number, opId: string) {
  const automation = await prisma.automation.findFirst({ where: { id: automationId }, include: { instagramAccount: true } });
  const step = automation && getFlow(automation)?.steps.find((s) => s.id === stepId);
  if (!automation || !step?.gift) return;
  const contact = await prisma.contact.findUnique({
    where: { workspaceId_igsid: { workspaceId: automation.workspaceId, igsid: userId } },
  });
  const result = contact?.email ? await claimGift(step.gift, contact.email, contact.username) : "error";
  if (result === "retry" && attempt < GIFT_MAX_ATTEMPTS) return scheduleGiftRetry(automation, stepId, userId, attempt + 1, opId);
  if (result === "retry" || result === "error") return giftFailed(automation, step.gift, contact?.username ?? userId, userId, contact?.email ?? null);

  const context = await createInstagramContext(automation.instagramAccount);
  if (context.provider !== "META") return;
  const retryOp = `${opId}:giftretry`;
  if (result === "ended") {
    await sendOnce(context, automation, { userId }, retryOp, `${step.id}:ended`, {
      text: "Poxa, esse presente era por tempo limitado e já encerrou 😕 Mas fica de olho que sempre tem novidade por aqui! 🎒",
    });
    return;
  }
  const nextId = result === "existing" ? step.existing ?? step.next : step.next;
  if (nextId) await runStep({ context, automation, recipient: { userId }, userId, username: contact?.username, stepId: nextId, opId: retryOp });
}
