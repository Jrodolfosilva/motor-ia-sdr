// Vínculo com o CRM (kanban): cada etapa interna do atendimento tem marcos, e cada marco pode
// mover o card para uma etapa do kanban e adicionar/remover etiquetas da conversa.
// O motor só decide QUANDO e O QUÊ; o adapter do CRM (PipelinePort) executa no provider.
import type { Agent, CrmAction, TurnContext } from './types';

export interface CrmEventDef {
  key: string;
  label: string;
  /** Etapa interna do atendimento a que o marco pertence. */
  stage: string;
  description: string;
  /** Ainda não dispara (depende da Fase 2). */
  later?: boolean;
}

/** Marcos fixos. Classificação é dinâmica: "classificado:<key>" para cada rótulo do agente. */
export const CRM_EVENTS: CrmEventDef[] = [
  { key: 'atendimento_iniciado', stage: '1. Recepção', label: 'Atendimento iniciado', description: 'A IA respondeu a primeira mensagem da lead.' },
  { key: 'perguntas_completas', stage: '2. Perguntas', label: 'Dados principais confirmados', description: 'As perguntas-gatilho da Explicação (ou todas, sem o módulo) respondidas ou confirmadas.' },
  { key: 'explicacao_enviada', stage: '3. Explicação', label: 'Explicação enviada', description: 'O módulo de explicação saiu; a IA começa a pedir documentos.' },
  { key: 'documento_recebido', stage: '4. Documentos', label: 'Documento recebido', description: 'Cada documento do roteiro que chegar (dispara uma vez por documento).' },
  { key: 'documentos_completos', stage: '4. Documentos', label: 'Documentos completos', description: 'Todos os documentos do roteiro recebidos.' },
  { key: 'pendencia_registrada', stage: '4. Documentos', label: 'Pendência registrada', description: 'A lead disse que manda depois, que não tem ou recusou um item.' },
  { key: 'passou_para_equipe', stage: '6. Encerramento', label: 'Passou para a equipe (outros motivos)', description: 'Pediu humano, limite de turnos, mídia ilegível ou falha - sem classificação.' },
  { key: 'sem_resposta', stage: 'Follow-up', label: 'Lead parou de responder', description: 'Follow-up por inatividade esgotado (todas as mensagens + espera final) sem resposta.' },
];

export const classificationEvent = (labelKey: string) => `classificado:${labelKey}`;

/** Ação configurada para o marco ("documento_recebido:<key>" usa a ação de "documento_recebido", idem pendência). */
export function crmActionFor(agent: Agent, event: string): CrmAction | null {
  const actions = agent.crm?.actions ?? {};
  const base = event.includes(':') && !event.startsWith('classificado:') ? event.split(':')[0] : event;
  const a = actions[event] ?? actions[base];
  if (!a) return null;
  const has = !!a.move_to || !!a.add_labels?.length || !!a.remove_labels?.length;
  return has ? a : null;
}

/**
 * Dispara o marco no CRM (uma vez por conversa). Sem ação configurada = nada acontece.
 * Erro no CRM nunca derruba o atendimento: vira um evento de aviso.
 */
export async function fireCrm(ctx: TurnContext, event: string, note = ''): Promise<void> {
  const { agent, store, pipeline } = ctx;
  const state = await store.loadState();
  const fired = state.crmFired ?? [];
  if (fired.includes(event)) return;
  await store.saveState({ crmFired: [...fired, event] });

  const action = crmActionFor(agent, event);
  if (!action) return;
  const crm = agent.crm!;
  const stageName = (id: string) => crm.stages.find((s) => s.id === id)?.name ?? id;
  const labelName = (id: string) => crm.labels.find((l) => l.id === id)?.name ?? id;
  const def = CRM_EVENTS.find((e) => event === e.key || event.startsWith(`${e.key}:`));
  const cls = event.startsWith('classificado:') ? agent.classification_labels.find((l) => `classificado:${l.key}` === event) : null;
  const what = def?.label ?? (cls ? `Classificado: ${cls.label}` : event);

  // card só anda para a frente (ordem das colunas), a menos que forward_only = false
  const order = (id: string | null | undefined) => (id ? crm.stages.findIndex((s) => s.id === id) : -1);
  let moveTo = action.move_to ?? null;
  if (moveTo && crm.forward_only !== false && order(moveTo) < order(state.crmStage)) moveTo = null;

  try {
    if (moveTo) {
      await pipeline.moveToStage?.(moveTo, note || what);
      await store.saveState({ crmStage: moveTo });
    }
    if (action.add_labels?.length) await pipeline.addLabels?.(action.add_labels);
    if (action.remove_labels?.length) await pipeline.removeLabels?.(action.remove_labels);
    const parts = [
      moveTo ? `→ ${stageName(moveTo)}` : action.move_to ? `(fica em ${stageName(state.crmStage!)}: não volta etapa)` : null,
      ...(action.add_labels ?? []).map((l) => `+${labelName(l)}`),
      ...(action.remove_labels ?? []).map((l) => `−${labelName(l)}`),
    ].filter(Boolean);
    await pipeline.emitEvent({ kind: 'info', message: `📌 CRM (${what}): ${parts.join(' · ')}` });
  } catch (e) {
    await pipeline.emitEvent({ kind: 'info', message: `⚠️ CRM falhou em "${what}": ${(e as Error).message.slice(0, 200)}` });
  }
}
