import { describe, expect, it } from "vitest";
import { parseFlowForm } from "@/lib/flows/templates";

describe("parseFlowForm", () => {
  it("builds the gift flow: open → email → phone (skippable) → gift → invited/existing", () => {
    const result = parseFlowForm({
      template: "gift",
      opening: "Feliz Dia do Designer!",
      openLabel: "Abrir meu presente 🎁",
      emailText: "Me passa seu melhor e-mail",
      phoneText: "Qual seu WhatsApp?",
      promo: "dia-do-designer",
      invitedText: "Cheque seu e-mail!",
      existingText: "Você já tem conta!",
    });
    if (!("flow" in result)) throw new Error(result.error);
    const byId = Object.fromEntries(result.flow.steps.map((s) => [s.id, s]));
    expect(result.flow.start).toBe("open");
    expect(byId.open.buttons?.[0].next).toBe("email");
    expect(byId.email).toMatchObject({ ask: "email", next: "phone" });
    expect(byId.phone).toMatchObject({ ask: "phone", skipLabel: "Pular", next: "gift" });
    expect(byId.gift).toMatchObject({ gift: "dia-do-designer", next: "invited", existing: "existing" });
  });

  it("builds a choices flow with links, a shared follow-up and a reminder", () => {
    const result = parseFlowForm({
      template: "choices",
      opening: "Mora no Brasil ou fora?",
      options: [
        { label: "Moro no Brasil", tags: ["brasil"], reply: "Obrigada!", continueLabel: "Quero saber mais", human: true },
        { label: "Já moro fora", reply: "Obrigada!", links: [{ label: "Conhecer", url: "https://site/x" }] },
      ],
      followUp: { text: "Anexei o PDF", links: [{ label: "Baixar PDF", url: "https://site/x.pdf" }, { label: "Aplicar", url: "https://site/a" }] },
      reminder: { hours: 20, text: "Passando aqui" },
    });
    if (!("flow" in result)) throw new Error(result.error);
    const byId = Object.fromEntries(result.flow.steps.map((s) => [s.id, s]));
    expect(byId.open.buttons).toHaveLength(2);
    expect(byId.option0.buttons?.map((b) => b.next)).toEqual(["followup", "human"]);
    expect(byId.option0.reminder).toBeUndefined(); // no link on this reply
    expect(byId.option1.reminder?.hours).toBe(20);
    expect(byId.followup.buttons).toHaveLength(2);
    // Every `next` points at a real step.
    const ids = new Set(result.flow.steps.map((s) => s.id));
    for (const s of result.flow.steps) for (const b of s.buttons ?? []) if (b.next) expect(ids.has(b.next)).toBe(true);
  });

  it("rejects more than 3 buttons on a reply and bad promo slugs", () => {
    const tooMany = parseFlowForm({
      template: "choices",
      opening: "x",
      options: [
        { label: "A", reply: "r", links: [{ label: "1", url: "https://a" }, { label: "2", url: "https://b" }], continueLabel: "mais", human: true },
        { label: "B", reply: "r" },
      ],
      followUp: { text: "f", links: [{ label: "x", url: "https://x" }] },
    });
    expect("error" in tooMany && tooMany.error).toMatch(/3 botões/);
    const badSlug = parseFlowForm({ template: "gift", opening: "x", openLabel: "x", emailText: "x", promo: "Dia Do Designer", invitedText: "x", existingText: "x" });
    expect("error" in badSlug).toBe(true);
  });
});
