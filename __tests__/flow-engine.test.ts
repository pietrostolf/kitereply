import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMessage, redis, queueAdd, db } = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    sendMessage: vi.fn(async (..._args: unknown[]) => ({ recipient_id: "u1", message_id: "m1" })),
    queueAdd: vi.fn(),
    redis: {
      store,
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => void store.set(k, v)),
      del: vi.fn(async (k: string) => void store.delete(k)),
    },
    db: {
      automation: { findFirst: vi.fn() },
      contact: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
      trackedLink: { findFirst: vi.fn(), create: vi.fn() },
      linkClick: { count: vi.fn() },
      operationalEvent: { create: vi.fn() },
    },
  };
});

vi.mock("@/lib/meta/client", () => ({ sendMessage }));
vi.mock("@/lib/queue/client", () => ({
  getRedisConnection: () => redis,
  getDMQueue: () => ({ add: queueAdd }),
  FLOW_REMINDER_JOB_NAME: "process-flow-reminder",
}));
vi.mock("@/lib/db/client", () => ({ prisma: db }));
vi.mock("@/lib/instagram/context", () => ({
  createInstagramContext: async () => ({ provider: "META", accessToken: "t", instagramId: "ig1" }),
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
    { id: "link", text: "Veja", buttons: [{ title: "Curso", url: "https://site/curso" }], reminder: { hours: 20, text: "Lembrete" } },
  ],
};
const automation = { id: "a1", workspaceId: "w1", flow, isActive: true, instagramAccount: { id: "acc1", instagramId: "ig1" } };
const context = { provider: "META" as const, accessToken: "t", instagramId: "ig1", unifiedLogin: true };

beforeEach(() => {
  vi.clearAllMocks();
  redis.store.clear();
  db.automation.findFirst.mockResolvedValue(automation);
  db.contact.findUnique.mockResolvedValue(null);
  db.contact.create.mockImplementation(async ({ data }) => ({ id: "c1", ...data }));
  db.contact.update.mockImplementation(async ({ data }) => ({ id: "c1", ...data }));
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
    const b = msg.attachment.payload.buttons[0];
    expect(b.type).toBe("web_url");
    expect(b.url).toContain("/r/abc?r=");
  });
  it("uses quick replies for more than 3 options", async () => {
    const buttons = ["A", "B", "C", "D"].map((title) => ({ title, next: "s2" }));
    const msg = (await buildMessage(automation, "s1", "Escolha", buttons, "u1", "Pular")) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(msg.quick_replies).toHaveLength(5);
    expect(msg.quick_replies[4].payload).toBe("flow:a1:s1:skip");
  });
});

describe("runStep", () => {
  it("opens with a private reply and stops there", async () => {
    await runStep({ context, automation, recipient: { commentId: "c9" }, userId: "u1", username: "ana", stepId: "s1" });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][2]).toEqual({ comment_id: "c9" });
    expect(JSON.stringify(sendMessage.mock.calls[0][3])).toContain("Oi ana!");
  });
  it("schedules the reminder", async () => {
    await runStep({ context, automation, recipient: { userId: "u1" }, userId: "u1", stepId: "link" });
    expect(queueAdd).toHaveBeenCalledWith("process-flow-reminder", expect.objectContaining({ stepId: "link" }), expect.objectContaining({ delay: 20 * 3600_000 }));
  });
});

describe("taps and answers", () => {
  it("ignores a payload aimed at another account", async () => {
    expect(await handleFlowPayload("u1", "flow:a1:s1:0", "other-ig")).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });
  it("tags on tap and asks the question", async () => {
    await handleFlowPayload("u1", "flow:a1:s1:0", "ig1");
    expect(db.contact.create).toHaveBeenCalledWith({ data: expect.objectContaining({ tags: ["brasil"] }) });
    expect(redis.store.get("flow_wait:ig1:u1")).toContain('"stepId":"s2"');
  });
  it("re-asks on an invalid email, then invites and confirms", async () => {
    redis.store.set("flow_wait:ig1:u1", JSON.stringify({ automationId: "a1", stepId: "s2", tries: 0 }));
    await handleFlowAnswer("u1", "ig1", "não sei");
    expect(JSON.stringify(sendMessage.mock.calls[0][3])).toContain("não parece certo");

    process.env.GIFT_ENDPOINT_URL = "https://gift";
    process.env.GIFT_ENDPOINT_SECRET = "s";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ result: "invited" }) })));
    db.contact.findUnique.mockResolvedValue({ id: "c1", email: null, tags: [] });
    db.contact.update.mockImplementation(async ({ data }) => ({ id: "c1", email: "ana@x.com", ...data }));
    await handleFlowAnswer("u1", "ig1", "ana@x.com");
    expect(db.contact.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ email: "ana@x.com" }) }));
    expect(JSON.stringify(sendMessage.mock.calls.at(-1)?.[3])).toContain("Cheque seu e-mail");
    expect(redis.store.has("flow_wait:ig1:u1")).toBe(false);
  });
  it("never says 'check your email' when the invite fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    db.contact.findUnique.mockResolvedValue({ id: "c1", email: "ana@x.com", tags: [] });
    db.contact.update.mockImplementation(async ({ data }) => ({ id: "c1", email: "ana@x.com", ...data }));
    await runStep({ context, automation, recipient: { userId: "u1" }, userId: "u1", stepId: "s3" });
    expect(db.operationalEvent.create).toHaveBeenCalled();
    expect(JSON.stringify(sendMessage.mock.calls)).not.toContain("Cheque seu e-mail");
  });
});

describe("sendFlowReminder", () => {
  it("skips people who clicked", async () => {
    db.linkClick.count.mockResolvedValue(1);
    await sendFlowReminder("a1", "link", "u1");
    expect(sendMessage).not.toHaveBeenCalled();
  });
  it("reminds people who didn't", async () => {
    db.linkClick.count.mockResolvedValue(0);
    await sendFlowReminder("a1", "link", "u1");
    expect(sendMessage).toHaveBeenCalledWith(expect.anything(), "ig1", { id: "u1" }, { text: "Lembrete" });
  });
});
