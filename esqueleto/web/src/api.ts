export type Role = 'user' | 'assistant' | 'event';

export interface EngineEvent {
  kind: 'handoff' | 'disqualify' | 'info';
  reason?: string;
  classification?: string | null;
  summary?: string | null;
  message?: string;
}

export interface MediaAnalysis {
  tipo: string;
  resumo: string;
  dados?: Record<string, unknown>;
  legivel?: boolean;
  fonte?: string;
}

export interface SimMessage {
  id: string;
  role: Role;
  type: string;
  body: string;
  createdAt?: string;
  event?: EngineEvent;
  replyTo?: string;
  mediaPath?: string | null;
  transcript?: string | null;
  /** Áudio do lead ainda sendo transcrito. */
  transcribing?: boolean;
  /** Nome original do arquivo enviado. */
  fileName?: string;
  /** Vídeo-recado do WhatsApp (bolinha). */
  videoNote?: boolean;
  aiAnalysis?: MediaAnalysis | { failed: true } | null;
}

export interface CallLog {
  step: string;
  model: string;
  systemPrompt: string;
  userMessage: string | null;
}

export type PendingStatus = 'depois' | 'nao_sabe' | 'vaga' | 'nao_tem' | 'recusou';
export interface PendingItem { status: PendingStatus; count: number; detail?: string | null }

export interface SessionState {
  status: string;
  turnsCount: number;
  classification: string | null;
  explanationSent?: boolean;
  /** Perguntas que vieram do formulário (null até o 1º turno). */
  formKeys: string[] | null;
  confirmedKeys: string[];
  pending?: Record<string, PendingItem>;
  /** Etapa do último follow-up e se a sequência esgotou sem resposta. */
  followupStage?: string | null;
  followupDone?: boolean;
  [k: string]: unknown;
}

export interface Session {
  id: string;
  phone: string;
  customFields: Record<string, unknown>;
  state: SessionState;
  messages: SimMessage[];
  logs: CallLog[];
  /** IA "digitando…" / "gravando áudio…". */
  typing?: false | 'typing' | 'recording';
  cost?: SessionCost;
  /** Card no kanban (simulado). */
  crm?: { stageId: string | null; labels: string[]; history: { at: string; stageId?: string; add?: string[]; remove?: string[]; note?: string }[] };
  /** Próximo follow-up por inatividade. `step` null = fechamento (espera final). */
  followupNext?: { at: number; stage: string; label: string; step: number | null; total: number } | null;
}

export interface CostItem {
  kind: 'tokens' | 'audio';
  step: string;
  label: string;
  model: string;
  input: number;
  output: number;
  cached: number;
  seconds: number;
  usd: number | null;
  brl: number | null;
}

export interface SessionCost {
  items: CostItem[];
  totals: { input: number; output: number; cached: number; audioSeconds: number; usd: number; brl: number; unpriced: string[] };
  fx: { rate: number; source: string; quotedAt: string | null };
  prices: {
    loadedAt: string | null;
    error: string | null;
    models: { model: string; price: { input: number; output: number; cached_input: number; per_minute: number } | null }[];
  };
}

// ---------- Recepção ----------
export type ReceptionKind = 'text' | 'audio' | 'video';
export interface ReceptionMessage {
  kind: ReceptionKind;
  enabled?: boolean;
  text?: string | null;
  media?: { path: string; mime?: string; file_name?: string } | null;
  caption?: string | null;
  transcript?: string | null;
  /** Vídeo como vídeo-recado (bolinha). Vazio = sim; false = vídeo normal. */
  video_note?: boolean | null;
}
export interface ReceptionScenario { messages: ReceptionMessage[]; after: 'wait' | 'continue' }
export interface Reception { volume: ReceptionScenario; form: ReceptionScenario; append_state_presence?: boolean }
export interface CrmStage { id: string; name: string }
export interface CrmLabel { id: string; name: string; color?: string | null }
export interface CrmAction { move_to?: string | null; add_labels?: string[]; remove_labels?: string[] }
export interface CrmConfig { stages: CrmStage[]; labels: CrmLabel[]; actions: Record<string, CrmAction>; forward_only?: boolean }
export interface CrmEventDef { key: string; label: string; stage: string; description: string; later?: boolean }

export interface Guardrails {
  rules: string[];
  video_reply?: string | null;
  audio_fail_reply?: string | null;
  file_fail_reply?: string | null;
  file_fail_action?: 'reply' | 'handoff' | 'handoff_always';
}
export interface ExplanationModule { enabled: boolean; messages: ReceptionMessage[]; after: 'wait' | 'continue'; trigger_fields: string[] }

/** URL para tocar/baixar um arquivo da pasta do kit (ex: "media/oi.ogg"). */
/**
 * Origem do backend. Vazio = mesma origem (app interno). O script de embed define a URL do
 * servidor público com setApiBase().
 */
let API_BASE = '';
export const setApiBase = (base: string) => { API_BASE = base.replace(/\/+$/, ''); };
export const apiUrl = (path: string) => `${API_BASE}${path}`;

/** Agente aberto no painel (ou o do link público): mídia "media/..." e uploads são dele. */
let KIT_KEY = '';
export const setKitKey = (key: string) => { KIT_KEY = key; };
export const getKitKey = () => KIT_KEY;

export const kitFileUrl = (path: string) =>
  apiUrl(`/api/kit-file?kit=${encodeURIComponent(KIT_KEY)}&path=${encodeURIComponent(path)}`);

/** URL de qualquer mídia de mensagem: gravações do simulador ("sim/...") ou arquivos do kit ("media/..."). */
export const mediaUrl = (path: string) =>
  path.startsWith('sim/') ? apiUrl(`/api/sim-file?path=${encodeURIComponent(path)}`) : kitFileUrl(path);

export interface BubbleDelay { min_seconds: number; max_seconds: number; chars_per_second: number }

// ---------- Kit / agente (espelha kits/*/kit.json) ----------

export type RuleOperator =
  | 'present' | 'contains_any' | 'not_contains_any'
  | 'gte_months' | 'lt_months' | 'months_since_gte' | 'months_since_lt' | 'months_to_field_gte' | 'months_to_field_lt';

export interface Rule { field: string; operator: RuleOperator; value?: unknown; to_field?: string | null }

export interface ClassificationLabel {
  key: string;
  label: string;
  description: string;
  outcome: 'qualify' | 'disqualify';
  rules?: Rule[];
  disqualify_message?: string | null;
  [k: string]: unknown;
}

/** Pergunta do roteiro. */
export interface RequiredField {
  key: string; label: string; question: string; confirm_question?: string | null;
  /** Rótulo curto na mensagem pronta de confirmação do formulário (vazio = a pergunta). */
  confirm_label?: string | null;
  /** Por que precisamos (a IA reforça quando a resposta não vem certa). */
  why?: string | null;
  /** Como a lead consegue descobrir/responder. */
  help?: string | null;
  /** Vezes que a IA reforça e pede de novo antes de deixar para a equipe (vazio = 2). */
  insist?: number | null;
  /** Follow-up se a lead parar nesta pergunta (vazio = sequência padrão). */
  followup?: FollowUpStep[] | null;
}

export type DocumentFileType = 'image' | 'pdf';

/** Documento do roteiro. */
export interface RequiredDocument {
  key: string;
  label: string;
  file_types: DocumentFileType[];
  accepted: string[];
  how_to_get?: string | null;
  request_message: string;
  validates?: string[];
  condition?: string | null;
  why?: string | null;
  insist?: number | null;
  essential?: boolean | null;
  followup?: FollowUpStep[] | null;
}

export interface FollowUpStep {
  step: number; delay_minutes: number; message: string; is_active: boolean;
  /** Template usado quando a janela de 24h do WhatsApp já fechou. Vazio = passo pulado fora da janela. */
  template_id?: string | null;
}

// ---------- Templates da Meta + integração Fale Fácil / Bitrix ----------
export interface WhatsAppTemplate {
  id: string;
  name: string;
  lang?: string | null;
  body: string;
  /** Valor de cada {{n}}: "{nome}", "{campo:<key>}" ou texto fixo. */
  params?: string[];
  header?: { type: 'image' | 'video' | 'document'; path?: string | null; url?: string | null } | null;
  note?: string | null;
}
export interface FieldMapping { crm_field: string; key: string; write_back?: boolean }
export interface IntegrationConfig {
  enabled: boolean;
  channel: 'falefacil';
  crm: 'bitrix';
  opening_mode: 'engine' | 'external';
  stage_map: Record<string, string>;
  active_stages: string[];
  field_map: FieldMapping[];
  handoff: { transfer_type: 'user' | 'queue'; transfer_id: string | null; assign_user_id: string | null };
  mirror_to_timeline: boolean;
  test_phones: string[];
}
export const defaultIntegration = (): IntegrationConfig => ({
  enabled: false, channel: 'falefacil', crm: 'bitrix', opening_mode: 'external', stage_map: {}, active_stages: [], field_map: [],
  handoff: { transfer_type: 'user', transfer_id: null, assign_user_id: null }, mirror_to_timeline: true, test_phones: [],
});
export interface SecretState { saved: boolean; hint: string | null }
export interface IntegrationInfo {
  secrets: { falefacil_api_key: SecretState; falefacil_webhook_token: SecretState; bitrix_webhook_url: SecretState };
  urls: { falefacil_webhook: string; bitrix_lead_webhook: string };
  public_base: string | null;
}
export interface BitrixCatalog {
  portal: string;
  stages: { id: string; name: string; sort: number; semantics: string | null }[];
  users: { id: string; name: string }[];
  fields: { code: string; label: string; type: string; items?: { id: string; value: string }[] }[];
  queues: { id: string; name: string }[];
  warnings: string[];
}
export interface LiveConversation {
  id: string; phone: string; leadId: string | null; leadUrl: string | null; status: string; classification: string | null;
  stage: string | null; messages: number; last: { role: string; body: string; type: string } | null; updatedAt: string;
}
/** Conversa registrada no log de 7 dias (resumo). */
export interface LiveLogSummary {
  id: string; leadId: string | null; leadUrl: string | null; phone: string; name: string | null; startedAt: string; lastAt: string;
  status: string | null; classification: string | null; stage: string | null; inbound: number; aiReplies: number;
}
export interface LiveLogMessage { role: 'user' | 'assistant' | 'event'; type: string; body: string; transcript?: string | null; mediaPath?: string | null; createdAt: string; event?: any }
export interface LiveLog extends LiveLogSummary { messages: LiveLogMessage[] }
export interface AiHealth {
  ok: boolean; checkedAt: string; mongo: boolean; redis: boolean;
  models: { model: string; roles: string[]; status: string; ok: boolean; ms: number; detail: string }[];
}
export interface LiveReport {
  days: number; since: string; bitrixError: string | null;
  totals: { leads: number; replied: number; aiActed: number; conversations: number };
  leads: { leadId: string; leadUrl: string | null; name: string; phone: string | null; createdAt: string; bitrixStage: string; conversations: LiveLogSummary[] }[];
}
/** Pergunta frequente. `replies` = respostas prontas (texto/áudio/vídeo); o motor alterna o formato. */
export interface Faq { question: string; answer: string; replies?: ReceptionMessage[] | null }

/** Lead de teste do simulador/link público. */
export type TestLeadKind = 'form' | 'frio';
export interface TestLead {
  cold_message?: string | null; name?: string; phone?: string; form_answers?: Record<string, string>;
  /** Tipos de lead oferecidos no teste (link público). Vazio = os dois. */
  lead_kinds?: TestLeadKind[] | null;
}

export interface KitFile {
  key: string;
  engine_version?: string;
  /** Agente-modelo: aparece como base sugerida ao criar agentes novos. */
  template?: boolean;
  kit: {
    name: string;
    category?: string;
    company_info?: string | null;
    faq: Faq[];
    media_library: unknown[];
    [k: string]: unknown;
  };
  agent: {
    name?: string;
    system_prompt_file?: string;
    provider: string;
    model?: string;
    models?: Partial<Record<'responder' | 'extractor' | 'qualifier' | 'vision', string>>;
    greeting_example?: string | null;
    consent_message?: string | null;
    fallback_message?: string | null;
    handoff_message?: string | null;
    disqualify_message?: string | null;
    handoff_keywords: string[];
    max_turns: number;
    debounce_seconds: number;
    required_fields: RequiredField[];
    required_documents?: RequiredDocument[];
    classification_labels: ClassificationLabel[];
    followup_steps?: FollowUpStep[];
    followup_confirmation?: FollowUpStep[] | null;
    followup_final_wait_minutes?: number | null;
    bubble_delay?: BubbleDelay | null;
    reception?: Reception | null;
    explanation?: ExplanationModule | null;
    guardrails?: Guardrails | null;
    crm?: CrmConfig | null;
    test_lead?: TestLead | null;
    form_confirmation?: { enabled: boolean; intro?: string | null; outro?: string | null } | null;
    templates?: WhatsAppTemplate[];
    opening_template_id?: string | null;
    integration?: IntegrationConfig | null;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export interface PublicAgent {
  key: string;
  name: string;
  /** Perguntas do roteiro (só chave e rótulo): viram os campos do formulário de teste. */
  fields: { key: string; label: string }[];
  documents: RequiredDocument[];
  test_lead: TestLead | null;
}

export interface PublicLink { enabled: boolean; token: string | null }
export const publicLinkUrl = (token: string) => `${location.origin}/t/${token}`;

export interface AgentSummary {
  key: string;
  name: string;
  kitName: string;
  category: string | null;
  template: boolean;
  publicLink: PublicLink;
  updatedAt: string;
}
export interface KitSection { id: string; label: string }

export interface AgentConfig {
  key: string;
  publicLink: PublicLink;
  kitPath: string;
  hasApiKey: boolean;
  kit: KitFile;
  system_prompt: string;
  crmEvents?: CrmEventDef[];
}


async function req<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const r = await fetch(apiUrl(path), {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    // sessão do painel expirou → App volta para a tela de login
    if (r.status === 401 && !path.startsWith('/api/auth/')) window.dispatchEvent(new Event('hub-auth-required'));
    let msg = `${r.status} ${r.statusText}`;
    try { msg = (await r.json()).error ?? msg; } catch { /* corpo não-JSON */ }
    throw new Error(msg);
  }
  return r.json();
}

export interface AuthUser { id: string; name: string; email: string; role: 'admin' }

export const api = {
  me: () => req<{ user: AuthUser }>('/api/auth/me').then((r) => r.user),
  login: (email: string, code: string) => req<{ user: AuthUser }>('/api/auth/login', { email, code }).then((r) => r.user),
  logout: () => req<{ ok: true }>('/api/auth/logout', {}),
  /** Nova conversa: `agent` no painel (admin) ou `token` do link público. */
  create: (target: { agent: string } | { token: string }, phone: string, custom_fields: Record<string, unknown> = {}) =>
    req<Session>('/api/sessions', { ...target, phone, custom_fields }),
  send: (id: string, body: string) => req<Session>(`/api/sessions/${id}/messages`, { type: 'text', body }),
  /** Foto ou PDF de verdade: o servidor guarda e a IA lê no turno (visão / texto do PDF). */
  sendFile: async (id: string, file: File, caption: string): Promise<void> => {
    const q = `name=${encodeURIComponent(file.name)}&caption=${encodeURIComponent(caption)}`;
    const r = await fetch(apiUrl(`/api/sessions/${id}/file?${q}`), {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
    if (!r.ok && r.status !== 202) {
      let msg = `${r.status} ${r.statusText}`;
      try { msg = (await r.json()).error ?? msg; } catch { /* corpo não-JSON */ }
      throw new Error(msg);
    }
  },
  /** Áudio gravado no microfone: o servidor transcreve (Whisper) e segue o fluxo. */
  sendAudio: async (id: string, audio: Blob): Promise<void> => {
    const r = await fetch(apiUrl(`/api/sessions/${id}/audio`), {
      method: 'POST',
      headers: { 'Content-Type': audio.type || 'audio/webm' },
      body: audio,
    });
    if (!r.ok && r.status !== 202) {
      let msg = `${r.status} ${r.statusText}`;
      try { msg = (await r.json()).error ?? msg; } catch { /* corpo não-JSON */ }
      throw new Error(msg);
    }
  },
  /** Lead de formulário: a IA abre a conversa sem esperar mensagem. */
  start: (id: string) => req<Session>(`/api/sessions/${id}/start`, {}),
  /** Teste: envia já o próximo follow-up (pula a espera). */
  followupNow: (id: string) => req<Session>(`/api/sessions/${id}/followup`, {}),
  reset: (id: string, custom_fields: Record<string, unknown> = {}) =>
    req<Session>(`/api/sessions/${id}/reset`, { custom_fields }),
  /** Atualizações ao vivo da sessão (balões, "digitando…", estado). */
  stream: (id: string, onSession: (s: Session) => void): (() => void) => {
    const es = new EventSource(apiUrl(`/api/sessions/${id}/stream`));
    es.onmessage = (e) => { try { onSession(JSON.parse(e.data)); } catch { /* ignora */ } };
    return () => es.close();
  },
  uploadMedia: async (file: File): Promise<{ path: string; mime: string; file_name: string; size: number }> => {
    const r = await fetch(apiUrl(`/api/agents/${encodeURIComponent(KIT_KEY)}/media?name=${encodeURIComponent(file.name)}`), {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
    if (!r.ok) {
      let msg = `${r.status} ${r.statusText}`;
      try { msg = (await r.json()).error ?? msg; } catch { /* corpo não-JSON */ }
      throw new Error(msg);
    }
    return r.json();
  },
  listAgents: () => req<{ agents: AgentSummary[]; sections: KitSection[] }>('/api/agents'),
  /** Em branco, ou a partir de `from` copiando só as `sections` escolhidas. */
  createAgent: (body: { name: string; from?: string | null; sections?: string[]; template?: boolean }) =>
    req<AgentConfig>('/api/agents', body),
  deleteAgent: (key: string) => req<{ ok: true }>(`/api/agents/${encodeURIComponent(key)}`, undefined, 'DELETE'),
  getAgent: (key: string) => req<AgentConfig>(`/api/agents/${encodeURIComponent(key)}`),
  saveAgent: (key: string, kit: KitFile, system_prompt: string) =>
    req<AgentConfig>(`/api/agents/${encodeURIComponent(key)}`, { kit, system_prompt }, 'PUT'),
  setPublicLink: (key: string, body: { enabled?: boolean; regenerate?: boolean }) =>
    req<PublicLink>(`/api/agents/${encodeURIComponent(key)}/public-link`, body, 'PUT'),
  integration: (key: string) => req<IntegrationInfo>(`/api/agents/${encodeURIComponent(key)}/integration`),
  saveSecrets: (key: string, body: Partial<Record<'falefacil_api_key' | 'falefacil_webhook_token' | 'bitrix_webhook_url', string>>) =>
    req<IntegrationInfo>(`/api/agents/${encodeURIComponent(key)}/integration/secrets`, body, 'PUT'),
  regenerateHooks: (key: string) => req<IntegrationInfo>(`/api/agents/${encodeURIComponent(key)}/integration/regenerate`, {}),
  testIntegration: (key: string) => req<Record<'falefacil' | 'bitrix', { ok: boolean; detail: string }>>(`/api/agents/${encodeURIComponent(key)}/integration/test`, {}),
  bitrixCatalog: (key: string) => req<BitrixCatalog>(`/api/agents/${encodeURIComponent(key)}/integration/catalog`),
  accountTemplates: (key: string) => req<{ templates: any[] }>(`/api/agents/${encodeURIComponent(key)}/integration/templates`),
  liveConversations: (key: string) => req<{ conversations: LiveConversation[] }>(`/api/agents/${encodeURIComponent(key)}/integration/conversations`),
  resetLiveConversation: (key: string, id: string) =>
    req<{ ok: true }>(`/api/agents/${encodeURIComponent(key)}/integration/conversations/${encodeURIComponent(id)}`, undefined, 'DELETE'),
  health: (key: string) => req<AiHealth>(`/api/agents/${encodeURIComponent(key)}/health`),
  liveReport: (key: string, days = 1) => req<LiveReport>(`/api/agents/${encodeURIComponent(key)}/integration/report?days=${days}`),
  liveLog: (key: string, id: string) => req<LiveLog>(`/api/agents/${encodeURIComponent(key)}/integration/logs/${encodeURIComponent(id)}`),
  /** Página do link público: só nome, documentos e lead de teste, sem prompt/config. */
  getPublicAgent: (token: string) => req<PublicAgent>(`/api/public/agent?t=${encodeURIComponent(token)}`),
};
