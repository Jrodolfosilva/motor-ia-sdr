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
  aiAnalysis?: MediaAnalysis | { failed: true } | null;
}

export interface CallLog {
  step: string;
  model: string;
  systemPrompt: string;
  userMessage: string | null;
}

export type PendingStatus = 'depois' | 'nao_tem' | 'recusou';
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
  file_fail_action?: 'reply' | 'handoff';
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

export const kitFileUrl = (path: string) => apiUrl(`/api/kit-file?path=${encodeURIComponent(path)}`);

/** URL de qualquer mídia de mensagem: gravações do simulador ("sim/...") ou arquivos do kit ("media/..."). */
export const mediaUrl = (path: string) =>
  path.startsWith('sim/') ? apiUrl(`/api/sim-file?path=${encodeURIComponent(path)}`) : kitFileUrl(path);

export interface BubbleDelay { min_seconds: number; max_seconds: number; chars_per_second: number }

// ---------- Kit / agente (espelha kits/*/kit.json) ----------

export type RuleOperator =
  | 'present' | 'contains_any' | 'not_contains_any'
  | 'gte_months' | 'lt_months' | 'months_since_gte' | 'months_since_lt';

export interface Rule { field: string; operator: RuleOperator; value?: unknown }

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
export interface RequiredField { key: string; label: string; question: string; confirm_question?: string | null }

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
}

export interface FollowUpStep { step: number; delay_minutes: number; message: string; is_active: boolean }
export interface Faq { question: string; answer: string }

export interface KitFile {
  key: string;
  engine_version?: string;
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
    followup_final_wait_minutes?: number | null;
    bubble_delay?: BubbleDelay | null;
    reception?: Reception | null;
    explanation?: ExplanationModule | null;
    guardrails?: Guardrails | null;
    crm?: CrmConfig | null;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export interface PublicAgent {
  name: string;
  documents: RequiredDocument[];
  publicMode: boolean;
}

export interface AgentConfig {
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
    let msg = `${r.status} ${r.statusText}`;
    try { msg = (await r.json()).error ?? msg; } catch { /* corpo não-JSON */ }
    throw new Error(msg);
  }
  return r.json();
}

export const api = {
  create: (phone: string, custom_fields: Record<string, unknown> = {}) =>
    req<Session>('/api/sessions', { phone, custom_fields }),
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
  reset: (id: string, custom_fields: Record<string, unknown> = {}) =>
    req<Session>(`/api/sessions/${id}/reset`, { custom_fields }),
  /** Atualizações ao vivo da sessão (balões, "digitando…", estado). */
  stream: (id: string, onSession: (s: Session) => void): (() => void) => {
    const es = new EventSource(apiUrl(`/api/sessions/${id}/stream`));
    es.onmessage = (e) => { try { onSession(JSON.parse(e.data)); } catch { /* ignora */ } };
    return () => es.close();
  },
  uploadMedia: async (file: File): Promise<{ path: string; mime: string; file_name: string; size: number }> => {
    const r = await fetch(apiUrl(`/api/agent/media?name=${encodeURIComponent(file.name)}`), {
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
  getAgent: () => req<AgentConfig>('/api/agent'),
  /** Versão pública (modo demo): só nome do agente e documentos, sem prompt/config. */
  getPublicAgent: () => req<PublicAgent>('/api/public/agent'),
  saveAgent: (kit: KitFile, system_prompt: string) => req<AgentConfig>('/api/agent', { kit, system_prompt }, 'PUT'),
};
