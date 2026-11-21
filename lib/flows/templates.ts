import { z } from "zod";
import type { Flow, FlowButton, FlowStep } from "./engine";

/**
 * The forms Mari fills in the campaign builder. The server turns a form into
 * flow steps (buildFlow), so a saved flow is always one of these shapes.
 */

const text = (max = 1000) => z.string().trim().min(1).max(max);
// Meta caps button titles at 20 characters; count code points so an emoji is one.
const label = z.string().trim().min(1).refine((v) => [...v].length <= 20, "máximo 20 caracteres");
const url = z.string().trim().url();
const tags = z.array(z.string().trim().min(1).max(40)).max(10).default([]);
const link = z.object({ label, url });

export const choicesFormSchema = z.object({
  template: z.literal("choices"),
  opening: text(),
  options: z
    .array(
      z.object({
        label,
        tags,
        reply: text(),
        /** Up to 2 links on the reply (e.g. "Conhecer o curso", "Baixar PDF"). */
        links: z.array(link).max(2).default([]),
        /** Button that leads to the shared follow-up message. */
        continueLabel: label.optional(),
        /** Adds "Tenho uma dúvida": the person talks to a human. */
        human: z.boolean().default(false),
      })
    )
    .min(2)
    .max(13),
  followUp: z.object({ text: text(), links: z.array(link).min(1).max(3) }).optional(),
  reminder: z
    .object({ hours: z.number().int().min(1).max(23), text: text(), link: link.optional() })
    .optional(),
});

export const giftFormSchema = z.object({
  template: z.literal("gift"),
  opening: text(),
  openLabel: label,
  emailText: text(),
  phoneText: text().optional(),
  skipLabel: label.default("Pular"),
  /** Promotion slug on the platform (e.g. "dia-do-designer"). */
  promo: z.string().trim().regex(/^[a-z0-9-]{2,60}$/),
  invitedText: text(),
  existingText: text(),
});

export const flowFormSchema = z.discriminatedUnion("template", [choicesFormSchema, giftFormSchema]);
export type FlowForm = z.infer<typeof flowFormSchema>;
export type FlowFormInput = z.input<typeof flowFormSchema>;
/** What is stored in Automation.flow: the runnable flow plus the form it came from. */
export type StoredFlow = Flow & { form: FlowForm };

const HUMAN_STEP: FlowStep = { id: "human", text: "Pode mandar aqui que eu respondo pessoalmente 😊" };

export function buildFlow(form: FlowForm): StoredFlow {
  if (form.template === "gift") {
    const steps: FlowStep[] = [
      { id: "open", text: form.opening, buttons: [{ title: form.openLabel, next: "email" }] },
      { id: "email", text: form.emailText, ask: "email", next: form.phoneText ? "phone" : "gift" },
      ...(form.phoneText ? [{ id: "phone", text: form.phoneText, ask: "phone" as const, skipLabel: form.skipLabel, next: "gift" }] : []),
      { id: "gift", text: "", gift: form.promo, next: "invited", existing: "existing" },
      { id: "invited", text: form.invitedText },
      { id: "existing", text: form.existingText },
    ];
    return { form, start: "open", steps };
  }

  const reminder = form.reminder && {
    hours: form.reminder.hours,
    text: form.reminder.text,
    buttons: form.reminder.link ? [{ title: form.reminder.link.label, url: form.reminder.link.url }] : undefined,
  };
  const steps: FlowStep[] = [
    {
      id: "open",
      text: form.opening,
      buttons: form.options.map((o, i) => ({ title: o.label, next: `option${i}`, tags: o.tags })),
    },
    ...form.options.map((o, i): FlowStep => {
      const buttons: FlowButton[] = [
        ...o.links.map((l) => ({ title: l.label, url: l.url })),
        ...(o.continueLabel && form.followUp ? [{ title: o.continueLabel, next: "followup" }] : []),
        ...(o.human ? [{ title: "Tenho uma dúvida", next: "human" }] : []),
      ];
      return { id: `option${i}`, text: o.reply, buttons, reminder: buttons.some((b) => b.url) ? reminder : undefined };
    }),
    ...(form.followUp
      ? [{ id: "followup", text: form.followUp.text, buttons: form.followUp.links.map((l) => ({ title: l.label, url: l.url })), reminder }]
      : []),
    HUMAN_STEP,
  ];
  return { form, start: "open", steps };
}

/** Problems a form can have that the schema alone can't express. */
export function flowFormErrors(form: FlowForm): string[] {
  if (form.template === "gift") return [];
  const errors: string[] = [];
  form.options.forEach((o, i) => {
    const count = o.links.length + (o.continueLabel ? 1 : 0) + (o.human ? 1 : 0);
    if (count > 3) errors.push(`Opção ${i + 1}: no máximo 3 botões (links + continuar + dúvida).`);
    if (o.continueLabel && !form.followUp) errors.push(`Opção ${i + 1}: o botão "${o.continueLabel}" precisa da mensagem seguinte.`);
  });
  return errors;
}

/** Parse and build in one step, for the API. */
export function parseFlowForm(input: unknown): { flow: StoredFlow } | { error: string } {
  const parsed = flowFormSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  const errors = flowFormErrors(parsed.data);
  if (errors.length) return { error: errors.join(" ") };
  return { flow: buildFlow(parsed.data) };
}
