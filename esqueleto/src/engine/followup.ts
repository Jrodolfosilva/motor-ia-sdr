// Follow-up por inatividade, por etapa do roteiro.
// A lead parou de responder → descobre ONDE ela parou (confirmação do formulário, uma pergunta ou um
// documento) e usa a sequência daquela etapa (ou a padrão do agente). Cada passo espera `delay_minutes`
// desde a última mensagem da conversa. Esgotou (passos + espera final) → marco "sem_resposta" no CRM.
// Quem chama decide QUANDO (servidor: varredura periódica); aqui fica o "o quê".
import { fireCrm } from './crm';
import { RequiredFieldsStatus } from './rules/requiredFields';
import type { Agent, ConversationState, FollowUpStep, TurnContext } from './types';

export interface FollowupPlan {
  /** Id da etapa: "confirmacao", "pergunta:<key>", "documento:<key>" ou "geral". */
  stage: string;
  /** Rótulo para o painel. */
  label: string;
  steps: FollowUpStep[];
}

const usable = (steps?: FollowUpStep[] | null) => (steps ?? []).filter((s) => s.is_active && s.message.trim());

/** Etapa em que a lead parou e a sequência que vale para ela. null = nada a fazer. */
export function followupPlan(agent: Agent, known: Record<string, unknown>, state: ConversationState): FollowupPlan | null {
  if (state.status !== 'active' || state.followupDone) return null;
  const general = usable(agent.followup_steps);
  const pick = (stage: string, label: string, own?: FollowUpStep[] | null): FollowupPlan | null => {
    const mine = usable(own);
    const steps = mine.length ? mine : general;
    return steps.length ? { stage, label, steps } : null;
  };
  const status = new RequiredFieldsStatus(agent.required_fields, known, agent.required_documents, state);
  if (status.toConfirm().length) return pick('confirmacao', 'Confirmação dos dados do formulário', agent.followup_confirmation);
  const q = status.missingQuestions()[0];
  if (q) return pick(`pergunta:${q.key}`, `Pergunta ${q.key}`, q.followup);
  const d = status.missingDocuments()[0];
  if (d) return pick(`documento:${d.key}`, `Documento ${d.label}`, d.followup);
  return pick('geral', 'Padrão', null);
}

export type FollowupDue =
  | { kind: 'step'; plan: FollowupPlan; index: number; dueAt: number }
  | { kind: 'exhausted'; plan: FollowupPlan; dueAt: number };

/**
 * Próximo follow-up e quando ele vence. `lastAt` = hora da última mensagem da conversa (ms).
 * `minuteMs` deixa o teste local rápido (ex: 1000 = cada "minuto" configurado vira 1 segundo).
 */
export function nextFollowup(
  agent: Agent, known: Record<string, unknown>, state: ConversationState, lastAt: number, minuteMs = 60_000,
): FollowupDue | null {
  const plan = followupPlan(agent, known, state);
  if (!plan) return null;
  const sent = state.followupStepSent ?? 0;
  if (sent < plan.steps.length) {
    return { kind: 'step', plan, index: sent, dueAt: lastAt + Math.max(0, plan.steps[sent].delay_minutes) * minuteMs };
  }
  const wait = agent.followup_final_wait_minutes;
  if (wait == null) return null;
  return { kind: 'exhausted', plan, dueAt: lastAt + Math.max(0, wait) * minuteMs };
}

function firstName(known: Record<string, unknown>): string {
  const n = String(known.nome ?? known.full_name ?? known.name ?? '').trim().split(/\s+/)[0] ?? '';
  return n ? n[0].toUpperCase() + n.slice(1).toLowerCase() : '';
}

/** Texto do passo com {nome} trocado pelo primeiro nome (sem nome: o placeholder some). */
export function renderFollowup(message: string, known: Record<string, unknown>): string {
  const name = firstName(known);
  const out = name ? message.replaceAll('{nome}', name) : message.replace(/,?\s*\{nome\}/g, '');
  return out.replace(/ +([,!?.])/g, '$1').replace(/ {2,}/g, ' ').trim();
}

/** Executa o follow-up vencido: envia o passo, ou fecha a sequência (CRM "sem_resposta"). */
export async function runFollowup(ctx: TurnContext, due: FollowupDue): Promise<void> {
  const { store, channel, pipeline } = ctx;
  if (due.kind === 'step') {
    const known = await store.getKnownFields();
    const step = due.plan.steps[due.index];
    await pipeline.emitEvent({ kind: 'info', message: `Follow-up ${due.index + 1}/${due.plan.steps.length} · ${due.plan.label}` });
    await channel.sendText(renderFollowup(step.message, known));
    await store.saveState({ followupStepSent: due.index + 1, followupStage: due.plan.stage });
    return;
  }
  await store.saveState({ followupDone: true, followupStage: due.plan.stage });
  await pipeline.emitEvent({ kind: 'info', message: `Follow-up esgotado sem resposta · parou em ${due.plan.label}` });
  await fireCrm(ctx, 'sem_resposta', `Parou em: ${due.plan.label}`);
}
