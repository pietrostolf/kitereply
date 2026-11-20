import { prisma } from "@/lib/db/client";
import { sendMessage } from "@/lib/meta/client";
import { createInstagramContext, type InstagramContext } from "@/lib/instagram/context";
import { getDMQueue, getRedisConnection, FLOW_REMINDER_JOB_NAME } from "@/lib/queue/client";
import { buildTrackedUrl } from "@/lib/tracking/message";
import { generateTrackedLinkSlug, hashRecipientId } from "@/lib/tracking/server";

/**
 * Multi-step DM flows (the ManyChat replacement). A flow is a list of steps
 * stored as JSON on Automation.flow; payloads `flow:<automationId>:<stepId>[:<button>]`
 * carry taps back here. Meta allows one private reply per comment, so a flow
 * only continues after the person taps or types: the start step must ask
 * something (buttons or a question).
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
  /** Sent `hours` later only if no link of this flow was clicked. */
  reminder?: { hours: number; text: string; buttons?: FlowButton[] };
};

export type Flow = { start: string; steps: FlowStep[] };

type FlowAutomation = {
  id: string;
  workspaceId: string;
  flow: unknown;
  instagramAccount: { instagramId: string; id: string };
};

export type Recipient = { commentId: string } | { userId: string };

const WAIT_TTL_SECONDS = 24 * 60 * 60; // Meta's messaging window
const waitKey = (igId: string, userId: string) => `flow_wait:${igId}:${userId}`;

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

async function upsertContact(
  workspaceId: string,
  igsid: string,
  data: { username?: string | null; tags?: string[]; email?: string; phone?: string; consent?: boolean }
) {
  const existing = await prisma.contact.findUnique({
    where: { workspaceId_igsid: { workspaceId, igsid } },
  });
  const tags = [...new Set([...(existing?.tags ?? []), ...(data.tags ?? [])])];
  const fields = {
    ...(data.username ? { username: data.username } : {}),
    ...(data.email ? { email: data.email } : {}),
    ...(data.phone ? { phone: data.phone } : {}),
    ...(data.consent && !existing?.consentAt ? { consentAt: new Date() } : {}),
    tags,
  };
  return existing
    ? prisma.contact.update({ where: { id: existing.id }, data: fields })
    : prisma.contact.create({ data: { workspaceId, igsid, ...fields } });
}

async function trackedUrl(automation: FlowAutomation, url: string, userId: string) {
  let link = await prisma.trackedLink.findFirst({
    where: { automationId: automation.id, destinationUrl: url },
  });
  link ??= await prisma.trackedLink.create({
    data: {
      workspaceId: automation.workspaceId,
      automationId: automation.id,
      slug: generateTrackedLinkSlug(),
      destinationUrl: url,
      position: 100, // after the campaign's own links
    },
  });
  return buildTrackedUrl(link.slug, undefined, hashRecipientId(userId));
}

/** Build the Messenger-format message for a step's text and buttons. */
export async function buildMessage(
  automation: FlowAutomation,
  stepId: string,
  text: string,
  buttons: FlowButton[] | undefined,
  userId: string,
  extraQuickReply?: string
): Promise<Record<string, unknown>> {
  const payload = (i: number) => `flow:${automation.id}:${stepId}:${i}`;
  const list = buttons ?? [];
  if (list.length > 0 && list.length <= 3) {
    return {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: text.slice(0, 640),
          buttons: await Promise.all(
            list.map(async (b, i) =>
              b.url
                ? { type: "web_url", title: b.title.slice(0, 20), url: await trackedUrl(automation, b.url, userId) }
                : { type: "postback", title: b.title.slice(0, 20), payload: payload(i) }
            )
          ),
        },
      },
    };
  }
  const quick = list.map((b, i) => ({ content_type: "text", title: b.title.slice(0, 20), payload: payload(i) }));
  if (extraQuickReply)
    quick.push({ content_type: "text", title: extraQuickReply.slice(0, 20), payload: `flow:${automation.id}:${stepId}:skip` });
  return quick.length ? { text: text.slice(0, 1000), quick_replies: quick.slice(0, 13) } : { text: text.slice(0, 1000) };
}

type RunArgs = {
  context: InstagramContext;
  automation: FlowAutomation;
  recipient: Recipient;
  userId: string;
  username?: string | null;
  stepId: string;
  /** Guards against a step chain that loops. */
  depth?: number;
};

export async function runStep(args: RunArgs): Promise<void> {
  const { context, automation, recipient, userId, username } = args;
  const depth = args.depth ?? 0;
  const flow = getFlow(automation);
  const step = flow?.steps.find((s) => s.id === args.stepId);
  if (!flow || !step || depth > 10) return;
  if (context.provider !== "META") return; // shortcut: flows are Meta-only, add Zernio when a Zernio account needs them

  const igId = automation.instagramAccount.instagramId;
  const contact = await upsertContact(automation.workspaceId, userId, { username, tags: step.tags });

  if (step.gift) {
    const result = contact.email ? await claimGift(step.gift, contact.email, contact.username) : "error";
    if (result === "error") {
      // Never tell someone to check their email when no invite went out.
      await prisma.operationalEvent.create({
        data: {
          workspaceId: automation.workspaceId,
          source: "WORKER",
          level: "ERROR",
          message: `Presente "${step.gift}" não enviado para @${contact.username ?? userId}: liberar à mão`,
          payload: { automationId: automation.id, igsid: userId, email: contact.email },
        },
      });
      await sendText(context, igId, recipient, "Recebi seu e-mail! 🎒 O presente vai chegar em algumas horas, tá? Se tiver qualquer dúvida, é só mandar aqui.", username);
      return;
    }
    if (step.text) await sendText(context, igId, recipient, step.text, username);
    const nextId = result === "existing" ? step.existing ?? step.next : step.next;
    if (nextId) await runStep({ ...args, stepId: nextId, depth: depth + 1 });
    return;
  }

  const text = render(step.text, username);
  const message = await buildMessage(automation, step.id, text, step.buttons, userId, step.ask ? step.skipLabel : undefined);
  await sendMessage(context, igId, toMetaRecipient(recipient), message);

  if (step.ask) {
    await getRedisConnection().set(
      waitKey(igId, userId),
      JSON.stringify({ automationId: automation.id, stepId: step.id, tries: 0 }),
      "EX",
      WAIT_TTL_SECONDS
    );
  }
  if (step.reminder) {
    await getDMQueue().add(
      FLOW_REMINDER_JOB_NAME,
      { instagramAccountId: igId, accountConnectionId: automation.instagramAccount.id, userId, automationId: automation.id, stepId: step.id },
      { delay: step.reminder.hours * 3600_000, jobId: `flowrem_${automation.id}_${step.id}_${userId}` }
    );
  }
  // A private reply can't be followed by more messages until the person answers.
  if (step.next && !step.ask && !step.buttons?.length && !("commentId" in recipient)) {
    await runStep({ ...args, recipient: { userId }, stepId: step.next, depth: depth + 1 });
  }
}

/** Handle a flow button tap (postback or quick reply payload). Returns false if not a flow payload. */
export async function handleFlowPayload(userId: string, payload: string, igId: string): Promise<boolean> {
  if (!payload.startsWith("flow:")) return false;
  const [, automationId, stepId, choice] = payload.split(":");
  const automation = await prisma.automation.findFirst({
    where: { id: automationId, isActive: true },
    include: { instagramAccount: true },
  });
  const step = automation && getFlow(automation)?.steps.find((s) => s.id === stepId);
  // The payload comes from the user's tap: only act on this account's own flows.
  if (!automation || !step || automation.instagramAccount.instagramId !== igId) return true;

  const base = { context: await createInstagramContext(automation.instagramAccount), userId };
  if (base.context.provider !== "META") return true;
  if (choice === "skip") {
    await getRedisConnection().del(waitKey(igId, base.userId));
    if (step.next) await runStep({ ...base, automation, recipient: { userId: base.userId }, stepId: step.next });
    return true;
  }
  const button = step.buttons?.[Number(choice)];
  if (!button) return true;
  if (button.tags?.length) await upsertContact(automation.workspaceId, base.userId, { tags: button.tags });
  if (button.next) await runStep({ ...base, automation, recipient: { userId: base.userId }, stepId: button.next });
  return true;
}

/** Handle a typed DM while a flow waits for an answer. Returns false if nothing was waiting. */
export async function handleFlowAnswer(userId: string, igId: string, text: string): Promise<boolean> {
  const redis = getRedisConnection();
  const raw = await redis.get(waitKey(igId, userId));
  if (!raw) return false;
  const wait = JSON.parse(raw) as { automationId: string; stepId: string; tries: number };
  const automation = await prisma.automation.findFirst({
    where: { id: wait.automationId },
    include: { instagramAccount: true },
  });
  const step = automation && getFlow(automation)?.steps.find((s) => s.id === wait.stepId);
  if (!automation || !step?.ask) {
    await redis.del(waitKey(igId, userId));
    return false;
  }
  const base = { context: await createInstagramContext(automation.instagramAccount), userId };
  if (base.context.provider !== "META") return true;

  const value = normalizeAnswer(step.ask, text);
  if (!value) {
    if (wait.tries >= 2) {
      await redis.del(waitKey(igId, base.userId));
      return true;
    }
    await redis.set(waitKey(igId, base.userId), JSON.stringify({ ...wait, tries: wait.tries + 1 }), "EX", WAIT_TTL_SECONDS);
    const retry = step.invalidText ?? (step.ask === "email" ? "Hmm, esse e-mail não parece certo. Pode mandar de novo?" : "Hmm, esse número não parece certo. Manda com DDD, por favor?");
    const message = await buildMessage(automation, step.id, retry, undefined, base.userId, step.skipLabel);
    await sendMessage(base.context, igId, { id: base.userId }, message);
    return true;
  }

  await redis.del(waitKey(igId, base.userId));
  await upsertContact(automation.workspaceId, base.userId, step.ask === "email" ? { email: value, consent: true } : { phone: value });
  if (step.next) await runStep({ ...base, automation, recipient: { userId: base.userId }, stepId: step.next });
  return true;
}

/** Delayed reminder: send only if none of this flow's links was clicked by the person. */
export async function sendFlowReminder(automationId: string, stepId: string, userId: string) {
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
  const contact = await prisma.contact.findUnique({
    where: { workspaceId_igsid: { workspaceId: automation.workspaceId, igsid: userId } },
  });
  const message = await buildMessage(automation, `${stepId}`, render(step.reminder.text, contact?.username), step.reminder.buttons, userId);
  await sendMessage(context, automation.instagramAccount.instagramId, { id: userId }, message);
}

function render(text: string, username?: string | null) {
  return text.replace(/\{username\}/g, username ?? "");
}

function toMetaRecipient(r: Recipient) {
  return "commentId" in r ? { comment_id: r.commentId } : { id: r.userId };
}

async function sendText(context: Extract<InstagramContext, { provider: "META" }>, igId: string, recipient: Recipient, text: string, username?: string | null) {
  await sendMessage(context, igId, toMetaRecipient(recipient), { text: render(text, username).slice(0, 1000) });
}

/**
 * Ask the community platform to invite the email to a promotion.
 * Returns "invited", "existing" or "error". The endpoint is the platform's
 * gift function (GIFT_ENDPOINT_URL), authenticated with a shared secret.
 */
async function claimGift(promo: string, email: string, instagram: string | null): Promise<"invited" | "existing" | "error"> {
  const url = process.env.GIFT_ENDPOINT_URL;
  const secret = process.env.GIFT_ENDPOINT_SECRET;
  if (!url || !secret) return "error";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ promo, email, instagram }),
    });
    const data = (await res.json()) as { result?: string };
    return data.result === "existing" ? "existing" : res.ok ? "invited" : "error";
  } catch {
    return "error";
  }
}
