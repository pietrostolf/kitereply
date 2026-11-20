import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMessage, redis, queueAdd, db, slot, usage } = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    sendMessage: vi.fn(async (..._args: unknown[]) => ({ recipient_id: "u1", message_id: "m1" })),
    queueAdd: vi.fn(),
    slot: vi.fn(async () => ({ allowed: true })),
    usage: vi.fn(async () => ({ allowed: true })),
    redis: {
      store,
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      exists: vi.fn(async (k: string) => (store.has(k) ? 1 : 0)),
      set: vi.fn(async (k: string, v: string) => void store.set(k, v)),
      del: vi.fn(async (k: string) => void store.delete(k)),
    },
    db: {
      automation: { findFirst: vi.fn() },
      contact: { findUnique: vi.fn(), upsert: vi.fn() },
      trackedLink: { findFirst: vi.fn(), create: vi.fn() },
      linkClick: { count: vi.fn() },
      operationalEvent: { create: vi.fn(async () => ({})) },
    },
  };
});

vi.mock("@/lib/meta/client", () => ({
  sendMessage,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/queue/client", () => ({
  getRedisConnection: () => redis,
  getDMQueue: () => ({ add: queueAdd }),
  FLOW_REMINDER_JOB_NAME: "process-flow-reminder",
}));
vi.mock("@/lib/db/client", () => ({ prisma: db }));
vi.mock("@/lib/billing/usage", () => ({ reserveWorkspaceDMSend: usage }));
vi.mock("@/lib/utils/rate-limiter", () => ({ reserveDMSlot: slot }));
vi.mock("@/lib/instagram/context", () => ({
  createInstagramContext: async () => ({ provider: "META", accessToken: "t", instagramId: "ig1", unifiedLogin: true }),
}));

import {
  buildMessage,
  handleFlowAnswer,
  handleFlowPayload,
  normalizeAnswer,
  runStep,
  sendFlowReminder,
  type Flow,
} from "@/lib/flows/engine";

const flow: Flow = {
  start: "s1",
  steps: [
    { id: "s1", text: "Oi {username}! Mora no Brasil?", buttons: [{ title: "Brasil", next: "s2", tags: ["brasil"] }, { title: "Fora", next: "s2" }] },
    { id: "s2", text: "Qual seu e-mail?", ask: "email", next: "s3" },
    { id: "s3", text: "", gift: "dia-do-designer", next: "s4", existing: "s5" },
    { id: "s4", text: "Cheque seu e-mail!" },
    { id: "s5", text: "Você já tem conta!" },
    {
      id: "link",
      text: "Veja",
      buttons: [{ title: "Curso", url: "https://site/curso" }],
      reminder: { hours: 30, text: "Lembrete", buttons: [{ title: "Dúvida", next: "s4" }] },
    },
  ],
};
const automation = { id: "a1", workspaceId: "w1", flow, isActive: true, instagramAccount: { id: "acc1", instagramId: "ig1" } };
const context = { provider: "META" as const, accessToken: "t", instagramId: "ig1", unifiedLogin: true };
const run = (stepId: string, recipient: { commentId: string } | { userId: string } = { userId: "u1" }, opId = "op1") =>
  runStep({ context, automation, recipient, userId: "u1", username: "ana", stepId, opId });
const sentTexts = () => JSON.stringify(sendMessage.mock.calls.map((c) => c[3]));

beforeEach(() => {
  vi.clearAllMocks();
  redis.store.clear();
  db.automation.findFirst.mockResolvedValue(automation);
  db.contact.findUnique.mockResolvedValue(null);
  db.contact.upsert.mockImplementation(async ({ create }) => ({ id: "c1", ...create }));
  db.trackedLink.findFirst.mockResolvedValue({ slug: "abc" });
  vi.unstubAllGlobals();
});

describe("normalizeAnswer", () => {
  it("accepts and lowercases emails, rejects junk", () => {
    expect(normalizeAnswer("email", " Maria@Gmail.COM ")).toBe("maria@gmail.com");
    expect(normalizeAnswer("email", "maria arroba gmail")).toBeNull();
  });
  it("needs at least 10 phone digits", () => {
    expect(normalizeAnswer("phone", "+55 47 99999-9999")).toBe("+5547999999999");
    expect(normalizeAnswer("phone", "9999")).toBeNull();
  });
});

describe("buildMessage", () => {
  it("uses a button template with tracked links for up to 3 buttons", async () => {
    const msg = (await buildMessage(automation, "link", "Veja", flow.steps[5].buttons, "u1")) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(msg.attachment.payload.buttons[0]).toMatchObject({ type: "web_url" });
    expect(msg.attachment.payload.buttons[0].url).toContain("/r/abc?r=");
  });
  it("uses quick replies for more than 3 options and keeps the skip within 13", async () => {
    const buttons = Array.from({ length: 13 }, (_, i) => ({ title: `O${i}`, next: "s2" }));
    const msg = (await buildMessage(automation, "s1", "Escolha", buttons, "u1", "Pular")) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(msg.quick_replies).toHaveLength(13);
    expect(msg.quick_replies[12].payload).toBe("flow:a1:s1:skip");
  });
  it("refuses links that quick replies would drop", async () => {
    const buttons = ["A", "B", "C", "D"].map((title) => ({ title, url: "https://x" }));
    await expect(buildMessage(automation, "s1", "x", buttons, "u1")).rejects.toThrow(/links/);
  });
});

describe("runStep", () => {
  it("opens with a private reply and stops there", async () => {
    await run("s1", { commentId: "c9" });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][2]).toEqual({ comment_id: "c9" });
    expect(sentTexts()).toContain("Oi ana!");
    expect(slot).not.toHaveBeenCalled(); // comment path already reserved
  });
  it("throws on a missing step instead of pretending it sent", async () => {
    await expect(run("nope")).rejects.toThrow(/not found/);
  });
  it("does not resend on a retry of the same event", async () => {
    await run("s4");
    await run("s4");
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
  it("caps the reminder inside the 24h window", async () => {
    await run("link");
    expect(queueAdd).toHaveBeenCalledWith("process-flow-reminder", expect.objectContaining({ stepId: "link" }), expect.objectContaining({ delay: 23 * 3600_000 }));
  });
  it("keeps the send successful when a side effect fails", async () => {
    queueAdd.mockRejectedValueOnce(new Error("redis down"));
    await expect(run("link")).resolves.toBeUndefined();
    expect(db.operationalEvent.create).toHaveBeenCalled();
  });
  it("never says 'check your email' when the invite fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    db.contact.upsert.mockResolvedValue({ id: "c1", email: "ana@x.com", tags: [] });
    await run("s3");
    expect(db.operationalEvent.create).toHaveBeenCalled();
    expect(sentTexts()).not.toContain("Cheque seu e-mail");
  });
});

describe("taps and answers", () => {
  it("ignores a payload aimed at another account", async () => {
    expect(await handleFlowPayload("u1", "flow:a1:s1:0", "other-ig", "p1")).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });
  it("tags on tap and asks the question", async () => {
    await handleFlowPayload("u1", "flow:a1:s1:0", "ig1", "p1");
    expect(db.contact.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ tags: ["brasil"] }) }));
    expect(redis.store.get("flow_wait:ig1:u1")).toContain('"stepId":"s2"');
  });
  it("routes a reminder button to the reminder's own button", async () => {
    await handleFlowPayload("u1", "flow:a1:link~r:0", "ig1", "p2");
    expect(sentTexts()).toContain("Cheque seu e-mail!");
  });
  it("lets an unrelated question through to normal handling", async () => {
    redis.store.set("flow_wait:ig1:u1", JSON.stringify({ automationId: "a1", stepId: "s2", tries: 0 }));
    expect(await handleFlowAnswer("u1", "ig1", "quanto custa o curso hoje?", "m0")).toBe(false);
    expect(redis.store.has("flow_wait:ig1:u1")).toBe(true);
  });
  it("re-asks on an invalid email, then invites and confirms", async () => {
    redis.store.set("flow_wait:ig1:u1", JSON.stringify({ automationId: "a1", stepId: "s2", tries: 0 }));
    expect(await handleFlowAnswer("u1", "ig1", "ana-gmail", "m1")).toBe(true);
    expect(sentTexts()).toContain("não parece certo");

    process.env.GIFT_ENDPOINT_URL = "https://gift";
    process.env.GIFT_ENDPOINT_SECRET = "s";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ result: "invited" }) })));
    db.contact.upsert.mockResolvedValue({ id: "c1", email: "ana@x.com", tags: [] });
    await handleFlowAnswer("u1", "ig1", "ana@x.com", "m2");
    expect(db.contact.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ email: "ana@x.com" }) }));
    expect(sentTexts()).toContain("Cheque seu e-mail");
    expect(redis.store.has("flow_wait:ig1:u1")).toBe(false);
  });
  it("keeps the question pending when the next step fails, so the retry works", async () => {
    redis.store.set("flow_wait:ig1:u1", JSON.stringify({ automationId: "a1", stepId: "s2", tries: 0 }));
    process.env.GIFT_ENDPOINT_URL = "https://gift";
    process.env.GIFT_ENDPOINT_SECRET = "s";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ result: "invited" }) })));
    db.contact.upsert.mockResolvedValue({ id: "c1", email: "ana@x.com", tags: [] });
    sendMessage.mockRejectedValueOnce(new Error("meta 500"));
    await expect(handleFlowAnswer("u1", "ig1", "ana@x.com", "m3")).rejects.toThrow();
    expect(redis.store.has("flow_wait:ig1:u1")).toBe(true);
    await handleFlowAnswer("u1", "ig1", "ana@x.com", "m3");
    expect(sentTexts()).toContain("Cheque seu e-mail");
  });
  it("stops after 2 bad answers and lets the message through", async () => {
    redis.store.set("flow_wait:ig1:u1", JSON.stringify({ automationId: "a1", stepId: "s2", tries: 2 }));
    expect(await handleFlowAnswer("u1", "ig1", "ana-gmail", "m4")).toBe(false);
    expect(redis.store.has("flow_wait:ig1:u1")).toBe(false);
  });
  it("ignores pending answers of a paused campaign", async () => {
    db.automation.findFirst.mockResolvedValue(null);
    redis.store.set("flow_wait:ig1:u1", JSON.stringify({ automationId: "a1", stepId: "s2", tries: 0 }));
    expect(await handleFlowAnswer("u1", "ig1", "ana@x.com", "m5")).toBe(false);
    expect(db.automation.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ isActive: true }) }));
  });
});

describe("sendFlowReminder", () => {
  it("skips people who clicked", async () => {
    db.linkClick.count.mockResolvedValue(1);
    await sendFlowReminder("a1", "link", "u1", "r1");
    expect(sendMessage).not.toHaveBeenCalled();
  });
  it("reminds people who didn't, with reminder-scoped buttons", async () => {
    db.linkClick.count.mockResolvedValue(0);
    await sendFlowReminder("a1", "link", "u1", "r1");
    expect(sentTexts()).toContain("flow:a1:link~r:0");
  });
});
