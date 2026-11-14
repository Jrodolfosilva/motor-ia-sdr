// Tipos centrais do motor. Nada aqui depende de Express, banco ou WhatsApp.

export type ProviderName = 'together' | 'openai' | 'anthropic' | 'deepseek';
export type ModelRole = 'responder' | 'extractor' | 'qualifier' | 'vision';

/** PERGUNTA do roteiro: dado que o lead informa por texto. */
export interface RequiredField {
  key: string;
  label: string;
  question: string;
  /** Como confirmar quando o dado já veio do formulário (Meta/LP). Opcional. */
  confirm_question?: string | null;
  /** Por que precisamos desse dado. A IA usa para reforçar quando o lead não sabe, recusa ou responde vago. */
  why?: string | null;
  /** Como o lead consegue descobrir/responder (onde olhar, o que serve como aproximação). */
  help?: string | null;
  /** Quantas vezes a IA reforça e pede de novo antes de deixar para a equipe. Vazio = padrão (2). */
  insist?: number | null;
  /** Follow-up se a lead parar de responder nesta pergunta. Vazio = sequência padrão do agente. */
  followup?: FollowUpStep[] | null;
}

export type DocumentFileType = 'image' | 'pdf';

/** DOCUMENTO do roteiro: arquivo que o lead envia para comprovar dados. */
export interface RequiredDocument {
  key: string;
  /** O que é (ex: "Print da Carteira de Trabalho"). */
  label: string;
  /** Formatos aceitos. */
  file_types: DocumentFileType[];
  /** O que serve como esse documento (ex: "ultrassom", "cartão da gestante"). */
  accepted: string[];
  /** Onde/como o lead consegue o documento. Usado quando ele não sabe ou não tem. */
  how_to_get?: string | null;
  /** Como pedir o documento. */
  request_message: string;
  /** Keys das PERGUNTAS que este documento comprova (ex: print_ctps → data_saida_ctps). */
  validates?: string[];
  /** Quando pedir (texto livre para a IA). Vazio = sempre. Ex: "só se já trabalhou registrada". */
  condition?: string | null;
  /** Por que precisamos do documento. A IA usa para reforçar quando o lead não tem, recusa ou manda errado. */
  why?: string | null;
  /** Quantas vezes a IA reforça e pede de novo antes de deixar para a equipe. Vazio = padrão (2). */
  insist?: number | null;
  /** Follow-up se a lead parar de responder neste documento. Vazio = sequência padrão do agente. */
  followup?: FollowUpStep[] | null;
}

export type RuleOperator =
  | 'present'
  | 'contains_any'
  | 'not_contains_any'
  | 'gte_months'
  | 'lt_months'
  | 'months_since_gte'
  | 'months_since_lt';

export interface Rule {
  field: string;
  operator: RuleOperator;
  value?: unknown;
}

export interface ClassificationLabel {
  key: string;
  label: string;
  description: string;
  outcome: 'qualify' | 'disqualify';
  rules?: Rule[];
  disqualify_message?: string | null;
  lost_reason_id?: number | null;
  chat_label_id?: number | null;
}

/**
 * Passo de follow-up: `delay_minutes` conta a partir da última mensagem da conversa
 * (a resposta da IA ou o follow-up anterior). `{nome}` = primeiro nome da lead.
 */
export interface FollowUpStep {
  step: number;
  delay_minutes: number;
  message: string;
  is_active: boolean;
}

export interface MediaItem {
  id: string;
  type: 'image' | 'video' | 'document' | 'audio';
  path: string;
  mime?: string;
  file_name?: string;
  caption?: string;
  when_to_use?: string;
  send_on_handoff?: boolean;
  /** O que o áudio/vídeo diz. Entra no histórico para a IA saber o que já foi falado. */
  transcript?: string | null;
}

// ---------- Recepção (1º contato) ----------

export type ReceptionKind = 'text' | 'audio' | 'video';

/** Uma mensagem da recepção: texto, ou áudio/vídeo gravado pela equipe. */
export interface ReceptionMessage {
  kind: ReceptionKind;
  /** false = desligada (mantém o conteúdo salvo, mas não envia). */
  enabled?: boolean;
  /** Texto (kind=text). */
  text?: string | null;
  /** Arquivo (kind=audio|video), caminho relativo à pasta do kit. */
  media?: { path: string; mime?: string; file_name?: string } | null;
  /** Legenda do vídeo. */
  caption?: string | null;
  /** O que o áudio/vídeo diz (a IA não ouve o arquivo; usa isto como contexto). */
  transcript?: string | null;
}

export interface ReceptionScenario {
  /** Mensagens em ordem (normalmente 2: apresentação + transição). Vazia = sem recepção. */
  messages: ReceptionMessage[];
  /** Depois da recepção: esperar o lead responder, ou a IA já seguir no mesmo turno. */
  after: 'wait' | 'continue';
}

// ---------- CRM / Kanban ----------

/** Etapa (coluna) do kanban no CRM. `id` = id no CRM (por enquanto, cadastrado à mão). */
export interface CrmStage { id: string; name: string }

/** Etiqueta da conversa no CRM. */
export interface CrmLabel { id: string; name: string; color?: string | null }

/** O que fazer no CRM quando um marco do atendimento acontece. */
export interface CrmAction {
  /** Mover o card para esta etapa (id). Vazio = não mexe na etapa. */
  move_to?: string | null;
  add_labels?: string[];
  remove_labels?: string[];
}

export interface CrmConfig {
  stages: CrmStage[];
  labels: CrmLabel[];
  /** Ação por marco (ver engine/crm.ts: CRM_EVENTS). Classificação: "classificado:<key do rótulo>". */
  actions: Record<string, CrmAction>;
  /** Card só anda para a frente (ordem de `stages`). Padrão: true. */
  forward_only?: boolean;
}

/** Conduta e limites: regras negativas + bloqueios de mídia com mensagem fixa. */
export interface Guardrails {
  /** Regras para a IA (fora do escopo, conversa sem sentido, tentativa de mudar instruções…). */
  rules: string[];
  /** Mensagem fixa quando a lead manda vídeo (vazio = a IA responde sozinha). */
  video_reply?: string | null;
  /** Mensagem fixa quando o áudio não deu pra transcrever (vazio = passa para humano). */
  audio_fail_reply?: string | null;
  /** Mensagem fixa quando foto/PDF não deu pra ler. */
  file_fail_reply?: string | null;
  /** Arquivo ilegível: responder com a mensagem fixa e seguir, ou passar para humano. */
  file_fail_action?: 'reply' | 'handoff';
}

/** Módulo de explicação: mensagens fixas entre as perguntas e o pedido de documentos. */
export interface ExplanationModule {
  enabled: boolean;
  /** Mensagens em ordem (texto, áudio ou vídeo). */
  messages: ReceptionMessage[];
  /** Depois de enviar: IA já pede o 1º documento, ou espera o lead responder. */
  after: 'wait' | 'continue';
  /** Dispara quando estas perguntas estiverem respondidas/confirmadas. Vazio = todas as perguntas. */
  trigger_fields: string[];
}

export interface Reception {
  /** Lead de volume (frio, sem dados): recepção + "vou te fazer umas perguntas". */
  volume: ReceptionScenario;
  /** Lead de formulário (pré-qualificado): apresentação + seguir para confirmar dados e pedir documentos. */
  form: ReceptionScenario;
  /** Acrescenta "Atendemos em todo o Brasil, com forte presença em <UF do DDD>" à 1ª mensagem de texto. */
  append_state_presence?: boolean;
}

export interface Kit {
  id: string;
  name: string;
  company_info?: string | null;
  faq: { question: string; answer: string }[];
  media_library: MediaItem[];
  vision_context?: {
    /** Frase de contexto do analisador de arquivos (ex: "Você analisa arquivos que leads enviam para um escritório de salário-maternidade."). */
    intro?: string;
    document_types?: string[];
    react_to_types?: string[];
  } | null;
}

export interface Agent {
  id: string;
  kit: Kit;
  provider: ProviderName;
  apiKey: string;
  model: string;
  models?: Partial<Record<ModelRole, string>>;
  system_prompt: string;
  /** Recepção por cenário. Ausente = derivada de greeting_example/consent_message (formato antigo). */
  reception?: Reception | null;
  /** Vínculo com o CRM: em cada marco do atendimento, mover o card no kanban e/ou mexer em etiquetas. */
  crm?: CrmConfig | null;
  /** Conduta e limites. Ausente = comportamento antigo (mídia ilegível passa para humano). */
  guardrails?: Guardrails | null;
  /** Explicação do benefício antes dos documentos. Ausente/desligado = a IA explica sozinha. */
  explanation?: ExplanationModule | null;
  greeting_example?: string | null;
  consent_message?: string | null;
  required_fields: RequiredField[];
  required_documents: RequiredDocument[];
  classification_labels: ClassificationLabel[];
  handoff_message?: string | null;
  disqualify_message?: string | null;
  fallback_message?: string | null;
  handoff_keywords: string[];
  max_turns: number;
  debounce_seconds: number;
  /** Sequência padrão (etapa sem sequência própria). */
  followup_steps: FollowUpStep[];
  /** Lead de formulário que parou na confirmação inicial dos dados. Vazio = sequência padrão. */
  followup_confirmation?: FollowUpStep[] | null;
  followup_final_wait_minutes?: number | null;
  followup_lost_reason_id?: number | null;
  log_executions: boolean;
  /** Ritmo dos balões: "digitando…" + pausa antes de cada um. Ausente = padrão (2 a 6s). */
  bubble_delay?: BubbleDelay | null;
}

export interface BubbleDelay {
  /** Pausa mínima antes de cada balão (s). */
  min_seconds: number;
  /** Pausa máxima (s). */
  max_seconds: number;
  /** Quantos caracteres "digitados" por segundo. */
  chars_per_second: number;
}

/** Item do roteiro que o lead não respondeu/enviou, com o motivo. */
/**
 * Por que o item do roteiro ficou sem resposta válida:
 * depois = não consegue agora; nao_sabe = não lembra/não sabe; vaga = respondeu algo que não serve
 * (vago, estranho, sem a informação); nao_tem = não tem de jeito nenhum; recusou = não quer informar.
 */
export type PendingStatus = 'depois' | 'nao_sabe' | 'vaga' | 'nao_tem' | 'recusou';

export interface PendingItem {
  status: PendingStatus;
  /** Quantas vezes o lead deu essa resposta para o item. */
  count: number;
  detail?: string | null;
}

export function modelFor(agent: Agent, role: ModelRole): string {
  const override = agent.models?.[role];
  return override && override !== '' ? override : agent.model;
}

export type MessageType =
  | 'text' | 'audio' | 'image' | 'document' | 'video' | 'sticker' | 'reaction' | 'internal_note';

export interface MediaAnalysis {
  tipo: string;
  resumo: string;
  dados: Record<string, unknown>;
  legivel: boolean;
  fonte?: string;
  modelo?: string;
}

export interface StoredMessage {
  id: string;                    // monotônico! (bigserial ou ulid)
  direction: 'inbound' | 'outbound';
  type: MessageType;
  body: string;
  mediaPath?: string | null;
  transcript?: string | null;
  aiAnalysis?: MediaAnalysis | { failed: true } | null;
  externalId?: string | null;
}

export type HandoffReason =
  | 'classified' | 'disqualified' | 'media_received' | 'handoff_keyword'
  | 'max_turns_exceeded' | 'turn_failed' | 'followup_exhausted';

export interface ConversationState {
  status: 'active' | 'handing_off' | 'handed_off';
  turnsCount: number;
  openingCompleted: boolean;
  classification: string | null;
  handoffReason: string | null;
  sentMediaIds: string[];
  followupStepSent: number;
  lastInboundAt: Date | null;
  isNew: boolean;
  /** Perguntas do roteiro que já vieram preenchidas do formulário (fixado no 1º turno). null = ainda não fixado. */
  formKeys: string[] | null;
  /** Perguntas vindas do formulário que o lead já confirmou (ou corrigiu) na conversa. */
  confirmedKeys: string[];
  /** Itens do roteiro (pergunta ou documento) que o lead adiou, não tem ou recusou. */
  pending: Record<string, PendingItem>;
  /** Módulo de explicação já enviado nesta conversa. */
  explanationSent?: boolean;
  /** Marcos de CRM já disparados (cada um dispara uma vez por conversa). */
  crmFired?: string[];
  /** Etapa do kanban onde o motor deixou o card por último. */
  crmStage?: string | null;
  /** Etapa em que a lead parou (ex: "confirmacao", "pergunta:data_parto") - do último follow-up enviado. */
  followupStage?: string | null;
  /** Sequência de follow-up esgotada (passos + espera final) sem resposta. */
  followupDone?: boolean;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string | ContentPart[];
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mime: string; data: string };

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmResult {
  text: string;
  toolCalls: { name: string; arguments: Record<string, any> }[];
  raw: any;
}

export interface LlmProvider {
  chat(args: {
    apiKey: string;
    model: string;
    messages: ChatMessage[];
    system?: string;
    tools?: ToolDef[];
    temperature?: number;
    /** Padrão do provider (20s). Visão/PDF precisa de mais. */
    timeoutMs?: number;
  }): Promise<LlmResult>;
}

export interface CallLog {
  step: 'extractor' | 'qualifier' | 'responder' | 'vision';
  systemPrompt: string;
  model: string;
  raw: any;
}

// ---------- PORTS ----------

export interface ConversationStore {
  loadState(): Promise<ConversationState>;
  saveState(patch: Partial<ConversationState>): Promise<void>;
  getKnownFields(): Promise<Record<string, unknown>>;
  saveKnownFields(fields: Record<string, unknown>): Promise<void>;
  /** Últimas `limit` mensagens, em ordem crescente de id. */
  recentMessages(limit: number): Promise<StoredMessage[]>;
  updateMessage(id: string, patch: Partial<StoredMessage>): Promise<void>;
  /** Última inbound que gera turno (text/audio/image/document/video). */
  lastInboundId(): Promise<string | null>;
  contact(): Promise<{ phone: string; name?: string; assignedToName?: string | null }>;
}

export interface ChannelPort {
  sendText(text: string): Promise<void>;
  sendMedia(item: MediaItem): Promise<void>;
  sendReaction(toMessage: StoredMessage, emoji: string): Promise<void>;
  postInternalNote(text: string): Promise<void>;
  /** Presença "digitando…" / "gravando áudio…" (WhatsApp: composing/recording). Opcional. */
  setTyping?(on: boolean, mode?: 'typing' | 'recording'): Promise<void>;
}

export type EngineEvent =
  | { kind: 'handoff'; reason: HandoffReason; classification?: string | null; summary?: string | null; confidence?: string | null }
  | { kind: 'disqualify'; classification: string; summary?: string | null; confidence?: string | null }
  | { kind: 'info'; message: string };

export interface PipelinePort {
  /** Produção: contato na etapa Onboarding e não pausado. Simulador: sempre true. */
  isInOnboarding(): Promise<boolean>;
  moveToHandoff(note: string): Promise<void>;
  moveToLost(note: string, lostReasonId?: number | null): Promise<void>;
  attachLabel(chatLabelId: number): Promise<void>;
  emitEvent(event: EngineEvent): Promise<void>;
  /** CRM genérico (kanban). Opcionais: o adapter do CRM implementa. */
  moveToStage?(stageId: string, note: string): Promise<void>;
  addLabels?(labelIds: string[]): Promise<void>;
  removeLabels?(labelIds: string[]): Promise<void>;
}

export interface MediaAnalyzerPort {
  supports(message: StoredMessage): boolean;
  /** `log` (opcional) = chamada de visão, para registrar uso/custo. */
  analyze(agent: Agent, message: StoredMessage): Promise<(MediaAnalysis & { log?: CallLog }) | null>;
}

export interface UsageRecorder {
  record(log: CallLog, userMessage: string | null): Promise<void>;
}

export interface TurnContext {
  agent: Agent;
  store: ConversationStore;
  channel: ChannelPort;
  pipeline: PipelinePort;
  llm: LlmProvider;
  media: MediaAnalyzerPort;
  usage: UsageRecorder;
  now?: Date;
  /** Relógio para o ritmo dos balões. Ausente = envia sem pausa (testes). */
  pacing?: { sleep(ms: number): Promise<void> };
}
