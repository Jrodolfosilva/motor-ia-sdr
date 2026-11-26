// Templates da Meta (WhatsApp oficial): abertura da conversa e follow-up fora da janela de 24h.
// O cliente cria e aprova o template na Meta; aqui só cadastramos nome, texto e o valor de cada {{n}}.
import { fireCrm } from './crm';
import type { Agent, TurnContext, WhatsAppTemplate } from './types';

/** Janela de atendimento do WhatsApp: texto livre só até 24h depois da última mensagem da lead. */
export const WINDOW_MS = 24 * 60 * 60 * 1000;
/** Margem para não mandar texto no limite da janela (pode chegar depois de fechar). */
export const WINDOW_MARGIN_MS = 10 * 60 * 1000;

export function windowOpen(lastInboundAt: number | null, now = Date.now()): boolean {
  return lastInboundAt != null && now - lastInboundAt < WINDOW_MS - WINDOW_MARGIN_MS;
}

/** Valor de um parâmetro: "{nome}", "{campo:<key>}" ou texto fixo. Vazio vira "-" (a Meta recusa parâmetro vazio). */
export function templateParam(spec: string, known: Record<string, unknown>): string {
  const s = (spec ?? '').trim();
  let v = s;
  if (s === '{nome}') v = ''; // nunca usa o nome da lead: vira "tudo bem" (a Meta recusa parâmetro vazio)
  else {
    const m = /^\{campo:([^}]+)\}$/.exec(s);
    if (m) v = String(known[m[1]] ?? '').trim();
  }
  return v || (s === '{nome}' ? 'tudo bem' : '-');
}

export const templateParams = (tpl: WhatsAppTemplate, known: Record<string, unknown>) =>
  (tpl.params ?? []).map((p) => templateParam(p, known));

/** Texto do template com as variáveis preenchidas (o que a lead lê; vai para o histórico). */
export function renderTemplate(tpl: WhatsAppTemplate, known: Record<string, unknown>): string {
  const values = templateParams(tpl, known);
  return (tpl.body ?? '').replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => values[Number(n) - 1] ?? '');
}

/** O que entra no histórico (a IA sabe o que a lead leu). Sem texto cadastrado: só o nome. */
export function templateHistoryText(tpl: WhatsAppTemplate, known: Record<string, unknown>): string {
  return renderTemplate(tpl, known).trim() || `[Template "${tpl.name}" enviado]`;
}

/** Quantas variáveis {{n}} o texto do template tem. */
export const templateVarCount = (body: string) =>
  Math.max(0, ...[...(body ?? '').matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1])));

export const findTemplate = (agent: Agent, id: string | null | undefined) =>
  (id ? agent.templates?.find((t) => t.id === id) : undefined) ?? null;

export const openingTemplate = (agent: Agent) => findTemplate(agent, agent.opening_template_id);

/**
 * Abre a conversa com o template (lead de formulário, antes de qualquer mensagem dela).
 * A recepção não sai depois: quando a lead responder, a IA segue para a confirmação dos dados.
 */
export async function openWithTemplate(ctx: TurnContext, tpl: WhatsAppTemplate): Promise<void> {
  const known = await ctx.store.getKnownFields();
  if (ctx.channel.sendTemplate) await ctx.channel.sendTemplate(tpl, known);
  else await ctx.channel.sendText(templateHistoryText(tpl, known));
  await ctx.store.saveState({ openedByTemplate: true });
  await ctx.pipeline.emitEvent({ kind: 'info', message: `Template de abertura enviado: ${tpl.name}` });
  await fireCrm(ctx, 'atendimento_iniciado');
}
