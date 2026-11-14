// Adapters do chat simulador sobre um objeto Session em memória.
// O servidor persiste a Session no MongoDB (adapters/sessionRepo.ts); os testes usam só a memória.
import { randomUUID } from 'node:crypto';
import type {
  Agent, ChannelPort, ConversationState, ConversationStore, EngineEvent, LlmProvider,
  MediaAnalyzerPort, PipelinePort, StoredMessage, TurnContext, UsageRecorder, CallLog,
} from '../engine/types';

export interface SimMessage extends StoredMessage {
  role: 'user' | 'assistant' | 'event';
  createdAt: string;
  event?: EngineEvent;
  replyTo?: string;
}

export interface Session {
  id: string;
  agentId: string;
  /** Conversa aberta pelo link público (/t/<token>). Desligar o link encerra o acesso a ela. */
  publicToken?: string | null;
  phone: string;
  customFields: Record<string, unknown>;
  state: ConversationState;
  messages: SimMessage[];
  logs: (CallLog & { userMessage: string | null })[];
  seq: number;
  /** "digitando…" ligado pelo motor entre os balões. */
  typing: false | 'typing' | 'recording';
  /** Estado do card no kanban (simulado): etapa atual, etiquetas e histórico. */
  crm: { stageId: string | null; labels: string[]; history: { at: string; stageId?: string; add?: string[]; remove?: string[]; note?: string }[] };
  /** Áudios transcritos (custo por minuto). */
  audioUsage: { model: string; seconds: number; messageId: string }[];
  /** Próximo follow-up por inatividade (hora em ms). `step` null = fechamento da sequência (espera final). */
  followupNext?: { at: number; stage: string; label: string; step: number | null; total: number } | null;
}

const sessions = new Map<string, Session>();

export function createSession(agentId: string, phone = '5511999999999', customFields: Record<string, unknown> = {}): Session {
  const s: Session = {
    id: randomUUID(), agentId, phone, customFields, messages: [], logs: [], seq: 0, typing: false, audioUsage: [], crm: { stageId: null, labels: [], history: [] },
    state: {
      status: 'active', turnsCount: 0, openingCompleted: false, classification: null,
      handoffReason: null, sentMediaIds: [], followupStepSent: 0, lastInboundAt: null, isNew: true,
      formKeys: null, confirmedKeys: [], pending: {},
    },
  };
  sessions.set(s.id, s);
  return s;
}

export const getSession = (id: string) => sessions.get(id);
export const deleteSession = (id: string) => sessions.delete(id);

/** id monotônico: o histórico depende da ordem por id. */
const nextId = (s: Session) => String(++s.seq).padStart(8, '0');

export function appendUser(s: Session, m: Pick<StoredMessage, 'type' | 'body'> & Partial<StoredMessage>): SimMessage {
  const msg: SimMessage = { direction: 'inbound', role: 'user', createdAt: new Date().toISOString(), ...m, id: nextId(s) };
  s.messages.push(msg);
  return msg;
}

const TURN_TYPES = ['text', 'audio', 'image', 'document', 'video'];

export function buildSimulatorContext(
  s: Session, agent: Agent, llm: LlmProvider, media: MediaAnalyzerPort,
  onChange: (s: Session) => void = () => {},
): TurnContext {
  const push = (m: Omit<SimMessage, 'id' | 'createdAt'>) => {
    s.messages.push({ ...m, id: nextId(s), createdAt: new Date().toISOString() });
    onChange(s);
  };

  const store: ConversationStore = {
    async loadState() { return { ...s.state }; },
    async saveState(patch) { s.state = { ...s.state, ...patch, isNew: false }; onChange(s); },
    async getKnownFields() { return { ...s.customFields }; },
    async saveKnownFields(f) { s.customFields = f; onChange(s); },
    async recentMessages(limit) {
      return s.messages.filter((m) => m.role !== 'event' && m.type !== 'internal_note').slice(-limit);
    },
    async updateMessage(id, patch) {
      const m = s.messages.find((x) => x.id === id);
      if (m) Object.assign(m, patch);
      onChange(s);
    },
    async lastInboundId() {
      return [...s.messages].reverse().find((m) => m.direction === 'inbound' && TURN_TYPES.includes(m.type))?.id ?? null;
    },
    async contact() { return { phone: s.phone, assignedToName: null }; },
  };

  const channel: ChannelPort = {
    async sendText(text) { push({ role: 'assistant', direction: 'outbound', type: 'text', body: text }); },
    async sendMedia(item) {
      push({ role: 'assistant', direction: 'outbound', type: item.type as any, body: item.caption ?? '', mediaPath: item.path, transcript: item.transcript ?? null });
    },
    async sendReaction(to, emoji) {
      push({ role: 'assistant', direction: 'outbound', type: 'reaction', body: emoji, replyTo: to.id });
    },
    async postInternalNote(text) {
      push({ role: 'event', direction: 'outbound', type: 'internal_note', body: text });
    },
    async setTyping(on, mode) {
      s.typing = on ? mode ?? 'typing' : false;
      onChange(s);
    },
  };

  const pipeline: PipelinePort = {
    async isInOnboarding() { return s.state.status === 'active'; },
    async moveToHandoff() {},
    async moveToLost() {},
    async attachLabel() {},
    async moveToStage(stageId, note) {
      s.crm.stageId = stageId;
      s.crm.history.push({ at: new Date().toISOString(), stageId, note });
      onChange(s);
    },
    async addLabels(ids) {
      s.crm.labels = [...new Set([...s.crm.labels, ...ids])];
      s.crm.history.push({ at: new Date().toISOString(), add: ids });
      onChange(s);
    },
    async removeLabels(ids) {
      s.crm.labels = s.crm.labels.filter((l) => !ids.includes(l));
      s.crm.history.push({ at: new Date().toISOString(), remove: ids });
      onChange(s);
    },
    async emitEvent(event) {
      push({ role: 'event', direction: 'outbound', type: 'internal_note', body: '', event });
    },
  };

  const usage: UsageRecorder = {
    async record(log, userMessage) { s.logs.push({ ...log, userMessage }); onChange(s); /* TODO custo: providers/usage */ },
  };

  return { agent, store, channel, pipeline, llm, media, usage };
}
