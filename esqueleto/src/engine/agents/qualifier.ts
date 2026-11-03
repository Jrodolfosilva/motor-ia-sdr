import { modelFor, type Agent, type CallLog, type ChatMessage, type LlmProvider, type ToolDef } from '../types';
import { PENDING_LABEL, RequiredFieldsStatus, type RoteiroProgress } from '../rules/requiredFields';
import { rulesMatch } from '../rules/classificationRules';
import { timeContextLine } from '../rules/misc';

const TEMPERATURE = 0.1;

export interface Decision {
  classification: string | null;
  summary: string | null;
  confidence: string | null;
}

const NONE: Decision = { classification: null, summary: null, confidence: null };

function tool(keys: string[]): ToolDef {
  return {
    name: 'classificar_lead',
    description: 'Classifica o lead e encerra o onboarding, passando a conversa para o time humano.',
    parameters: {
      type: 'object',
      properties: {
        classificacao: { type: 'string', enum: keys },
        resumo: { type: 'string', description: 'Resumo curto do caso para o atendente humano que assume a conversa.' },
        certeza: { type: 'string', enum: ['alta', 'media', 'baixa'], description: 'Sua própria confiança nesta classificação - não muda o encaminhamento, é sinal pra revisão humana.' },
      },
      required: ['classificacao'],
    },
  };
}

export async function decide(
  llm: LlmProvider, agent: Agent, history: ChatMessage[], known: Record<string, unknown>, now?: Date,
  progress: RoteiroProgress = {},
): Promise<{ decision: Decision; log: CallLog | null }> {
  const labels = agent.classification_labels;
  if (labels.length === 0) return { decision: NONE, log: null };

  const status = new RequiredFieldsStatus(agent.required_fields, known, agent.required_documents, progress);

  // DESQUALIFICAÇÃO ANTECIPADA (código, sem LLM): rótulo de desqualificar cuja regra já bate com
  // dados firmes (respondidos na conversa, confirmados ou lidos em documento) encerra na hora,
  // sem fazer a pessoa passar pelo roteiro inteiro. Dado do formulário ainda a confirmar não conta.
  const early = labels.find((l) =>
    l.outcome === 'disqualify' && !!l.rules?.length
    && l.rules.every((r) => status.isSettled(r.field))
    && rulesMatch(l.rules, known, now));
  if (early) {
    return { decision: { classification: early.key, summary: 'Desqualificado por regra (antes de completar o roteiro).', confidence: 'alta' }, log: null };
  }

  // GATE EM CÓDIGO: roteiro incompleto → nem chama o LLM.
  if (!status.isComplete()) return { decision: NONE, log: null };

  // Regra determinística (na ordem declarada) decide sem LLM.
  const byRule = labels.find((l) => rulesMatch(l.rules, known, now));
  if (byRule) {
    return { decision: { classification: byRule.key, summary: 'Classificado automaticamente por regra.', confidence: 'alta' }, log: null };
  }

  const fieldLines = [
    ...status.fields.map((f) => `- "${f.label}": "${String(status.value(f.key) ?? '')}"`),
    ...status.documents.map((d) => `- [documento] ${d.label}: "${String(status.value(d.key) ?? '')}"`),
    ...status.unresolvedButReleased().map((p) => `- PENDENTE ${p.label}: ${PENDING_LABEL[p.item.status]}${p.item.detail ? ` ("${p.item.detail}")` : ''}`),
  ];
  const labelLines = labels.map((l) => `- ${l.key}: ${l.label} - ${l.description}`);
  const system = [
    agent.system_prompt,
    timeContextLine(null, now),
    fieldLines.length ? `Todos os dados do roteiro já foram coletados para este lead:\n${fieldLines.join('\n')}` : null,
    `Decida se o lead já pode ser classificado. Chame classificar_lead a menos que a própria conversa deixe claro que falta uma confirmação explícita do lead antes disso (double-check) - nesse caso não chame nenhuma função. Classificações disponíveis:\n${labelLines.join('\n')}`,
    'Além da classificação, informe sua própria certeza nessa decisão (campo certeza: "alta", "media" ou "baixa") - isso não muda o encaminhamento, é só um sinal pra quem for revisar o caso depois saber quais merecem checagem antes de confiar. Use "baixa" sempre que a decisão dependeu de inferir algo que o lead não disse com todas as letras.',
  ].filter(Boolean).join('\n\n');

  const model = modelFor(agent, 'qualifier');
  const res = await llm.chat({
    apiKey: agent.apiKey, model, messages: history, system,
    tools: [tool(labels.map((l) => l.key))], temperature: TEMPERATURE,
  });
  const log: CallLog = { step: 'qualifier', systemPrompt: system, model, raw: res.raw };

  const call = res.toolCalls.find((c) => c.name === 'classificar_lead');
  if (!call) return { decision: NONE, log };
  return {
    decision: {
      classification: call.arguments.classificacao ?? 'qualificado',
      summary: call.arguments.resumo ?? null,
      confidence: call.arguments.certeza ?? null,
    },
    log,
  };
}
