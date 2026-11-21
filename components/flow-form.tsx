"use client";

/**
 * Editor for multi-step flows ("Pergunta com botões", "Presente"). Produces the
 * form stored in Automation.flow.form; the server builds the steps from it.
 *
 * shortcut: labels are Portuguese only (the instance serves Moda na Mochila);
 * move them to lib/i18n when this fork is offered to other people.
 */

import type { FlowFormInput } from "@/lib/flows/templates";

type ChoicesForm = Extract<FlowFormInput, { template: "choices" }>;
type GiftForm = Extract<FlowFormInput, { template: "gift" }>;
type Option = ChoicesForm["options"][number];
type Link = { label: string; url: string };

const field =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none";
const box = "rounded-lg border border-border p-3 space-y-2";

const emptyOption = (): Option => ({ label: "", reply: "", tags: [], links: [], human: false });

export const newFlowForm = (template: "choices" | "gift"): FlowFormInput =>
  template === "choices"
    ? { template, opening: "", options: [emptyOption(), emptyOption()] }
    : {
        template,
        opening: "",
        openLabel: "Abrir meu presente 🎁",
        emailText: "",
        phoneText: "",
        skipLabel: "Pular",
        promo: "",
        invitedText: "",
        existingText: "",
      };

function Text({ value, onChange, placeholder, rows = 3 }: { value: string; onChange: (v: string) => void; placeholder: string; rows?: number }) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label={placeholder}
      rows={rows}
      maxLength={1000}
      className={`${field} resize-none`}
    />
  );
}

function Line({ value, onChange, placeholder, max = 200 }: { value: string; onChange: (v: string) => void; placeholder: string; max?: number }) {
  return <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} maxLength={max} className={field} />;
}

function Links({ links, max, onChange }: { links: Link[]; max: number; onChange: (l: Link[]) => void }) {
  return (
    <div className="space-y-2">
      {links.map((l, i) => (
        <div key={i} className="flex gap-2">
          <Line value={l.label} onChange={(label) => onChange(links.map((x, j) => (j === i ? { ...x, label } : x)))} placeholder="Texto do botão" max={20} />
          <Line value={l.url} onChange={(url) => onChange(links.map((x, j) => (j === i ? { ...x, url } : x)))} placeholder="https://…" />
          <button type="button" onClick={() => onChange(links.filter((_, j) => j !== i))} className="text-xs text-muted hover:text-foreground" aria-label="Remover link">
            ✕
          </button>
        </div>
      ))}
      {links.length < max && (
        <button type="button" onClick={() => onChange([...links, { label: "", url: "" }])} className="text-xs font-medium text-accent hover:underline">
          + Botão com link
        </button>
      )}
    </div>
  );
}

function ChoicesEditor({ form, onChange }: { form: ChoicesForm; onChange: (f: ChoicesForm) => void }) {
  const setOption = (i: number, patch: Partial<Option>) =>
    onChange({ ...form, options: form.options.map((o, j) => (j === i ? { ...o, ...patch } : o)) });
  return (
    <div className="space-y-3">
      <Text value={form.opening} onChange={(opening) => onChange({ ...form, opening })} placeholder="Primeira DM (ex.: Você já mora fora ou ainda mora no Brasil?)" />
      {form.options.map((o, i) => (
        <div key={i} className={box}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted">Opção {i + 1}</span>
            {form.options.length > 2 && (
              <button type="button" onClick={() => onChange({ ...form, options: form.options.filter((_, j) => j !== i) })} className="text-xs text-muted hover:text-foreground">
                Remover
              </button>
            )}
          </div>
          <Line value={o.label} onChange={(label) => setOption(i, { label })} placeholder="Botão (ex.: Moro no Brasil 🇧🇷)" max={20} />
          <Line
            value={(o.tags ?? []).join(", ")}
            onChange={(v) => setOption(i, { tags: v.split(",").map((t) => t.trim()).filter(Boolean) })}
            placeholder="Etiquetas, separadas por vírgula (opcional)"
          />
          <Text value={o.reply} onChange={(reply) => setOption(i, { reply })} placeholder="Resposta para quem escolher esta opção" />
          <Links links={o.links ?? []} max={2} onChange={(links) => setOption(i, { links })} />
          <Line value={o.continueLabel ?? ""} onChange={(v) => setOption(i, { continueLabel: v || undefined })} placeholder='Botão para a mensagem seguinte (opcional, ex.: "Quero saber mais ✨")' max={20} />
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input type="checkbox" checked={o.human ?? false} onChange={(e) => setOption(i, { human: e.target.checked })} />
            Botão “Tenho uma dúvida” (a Mari responde)
          </label>
        </div>
      ))}
      {form.options.length < 13 && (
        <button type="button" onClick={() => onChange({ ...form, options: [...form.options, emptyOption()] })} className="text-xs font-medium text-accent hover:underline">
          + Outra opção
        </button>
      )}

      <div className={box}>
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={Boolean(form.followUp)}
            onChange={(e) => onChange({ ...form, followUp: e.target.checked ? { text: "", links: [{ label: "", url: "" }] } : undefined })}
          />
          Mensagem seguinte (para o botão de continuar)
        </label>
        {form.followUp && (
          <>
            <Text value={form.followUp.text} onChange={(text) => onChange({ ...form, followUp: { ...form.followUp!, text } })} placeholder="Ex.: Perfeito! Aqui está o PDF com todas as informações…" />
            <Links links={form.followUp.links} max={3} onChange={(links) => onChange({ ...form, followUp: { ...form.followUp!, links } })} />
          </>
        )}
      </div>

      <div className={box}>
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input type="checkbox" checked={Boolean(form.reminder)} onChange={(e) => onChange({ ...form, reminder: e.target.checked ? { hours: 20, text: "" } : undefined })} />
          Lembrete para quem não clicou no link
        </label>
        {form.reminder && (
          <>
            <div className="flex items-center gap-2 text-sm text-foreground">
              <span className="text-xs text-muted">Depois de</span>
              <input
                type="number"
                min={1}
                max={23}
                value={form.reminder.hours}
                onChange={(e) => onChange({ ...form, reminder: { ...form.reminder!, hours: Math.max(1, Math.min(23, Math.floor(Number(e.target.value) || 1))) } })}
                aria-label="Horas até o lembrete"
                className="w-16 rounded-lg border border-border bg-surface px-2 py-1 text-sm"
              />
              <span className="text-xs text-muted">horas (máx. 23, por causa da janela de 24h do Instagram)</span>
            </div>
            <Text value={form.reminder.text} onChange={(text) => onChange({ ...form, reminder: { ...form.reminder!, text } })} placeholder="Ex.: Passando aqui caso a mensagem de ontem tenha se perdido…" />
            <Links
              links={form.reminder.link ? [form.reminder.link] : []}
              max={1}
              onChange={(l) => onChange({ ...form, reminder: { ...form.reminder!, link: l[0] } })}
            />
          </>
        )}
      </div>
    </div>
  );
}

function GiftEditor({ form, onChange }: { form: GiftForm; onChange: (f: GiftForm) => void }) {
  const set = (patch: Partial<GiftForm>) => onChange({ ...form, ...patch });
  return (
    <div className="space-y-3">
      <Text value={form.opening} onChange={(opening) => set({ opening })} placeholder="Primeira DM (ex.: Feliz Dia do Designer! Hoje o presente é seu…)" />
      <Line value={form.openLabel} onChange={(openLabel) => set({ openLabel })} placeholder="Botão (ex.: Abrir meu presente 🎁)" max={20} />
      <Text value={form.emailText} onChange={(emailText) => set({ emailText })} placeholder="Pedido do e-mail (diga que, ao enviar, a pessoa topa receber conteúdos)" />
      <div className={box}>
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input type="checkbox" checked={form.phoneText !== undefined && form.phoneText !== null} onChange={(e) => set({ phoneText: e.target.checked ? "" : undefined })} />
          Pedir WhatsApp depois do e-mail (com botão para pular)
        </label>
        {form.phoneText !== undefined && (
          <>
            <Text value={form.phoneText} onChange={(phoneText) => set({ phoneText })} placeholder="Ex.: Última costura! 🪡 Qual seu WhatsApp?" />
            <Line value={form.skipLabel ?? "Pular"} onChange={(skipLabel) => set({ skipLabel })} placeholder="Botão de pular" max={20} />
          </>
        )}
      </div>
      <Line value={form.promo} onChange={(promo) => set({ promo: promo.toLowerCase() })} placeholder="Código da promoção na plataforma (ex.: dia-do-designer)" max={60} />
      <Text value={form.invitedText} onChange={(invitedText) => set({ invitedText })} placeholder="Quando o convite sai: cheque seu e-mail…" />
      <Text value={form.existingText} onChange={(existingText) => set({ existingText })} placeholder="Para quem já tem conta: liberamos as aulas, é só entrar…" />
    </div>
  );
}

export default function FlowFormEditor({ value, onChange }: { value: FlowFormInput | null; onChange: (v: FlowFormInput | null) => void }) {
  const choices: Array<[FlowFormInput["template"] | null, string]> = [
    [null, "Link simples (DM com link)"],
    ["choices", "Pergunta com botões"],
    ["gift", "Presente (pede e-mail e convida na plataforma)"],
  ];
  return (
    <div className="space-y-3">
      <div className="grid gap-2">
        {choices.map(([template, title]) => {
          const checked = (value?.template ?? null) === template;
          return (
            <button
              key={title}
              type="button"
              onClick={() => onChange(template ? (value?.template === template ? value : newFlowForm(template)) : null)}
              className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left text-sm ${checked ? "border-accent bg-accent/5" : "border-border hover:border-border-hover"}`}
              aria-pressed={checked}
            >
              <span className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border ${checked ? "border-accent" : "border-zinc-500"}`}>
                {checked && <span className="h-2 w-2 rounded-full bg-accent" />}
              </span>
              <span className="flex-1 text-foreground">{title}</span>
            </button>
          );
        })}
      </div>
      {value?.template === "choices" && <ChoicesEditor form={value} onChange={onChange} />}
      {value?.template === "gift" && <GiftEditor form={value} onChange={onChange} />}
      {value && <p className="text-xs text-muted">{"{username}"} personaliza qualquer texto.</p>}
    </div>
  );
}
