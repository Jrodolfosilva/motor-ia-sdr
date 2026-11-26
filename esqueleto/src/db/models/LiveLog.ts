// Coleção `live_logs`: cópia de cada conversa REAL (WhatsApp + Bitrix) para auditoria.
// Independe da sessão (apagar/recomeçar a conversa não apaga o log). Some sozinho 7 dias após a última atividade.
import { Schema, model } from 'mongoose';

export const LIVE_LOG_TTL_DAYS = 7;

export interface LiveLogMessage {
  role: 'user' | 'assistant' | 'event';
  type: string;
  body: string;
  transcript?: string | null;
  mediaPath?: string | null;
  createdAt: string;
  event?: unknown;
}

export interface LiveLogDoc {
  _id: string; // `${sessionId}_${startedAt em ms}` (conversa recomeçada = log novo)
  sessionId: string;
  kitKey: string;
  leadId: string | null;
  leadUrl: string | null;
  phone: string;
  name: string | null;
  startedAt: Date;
  lastAt: Date;
  status: string | null;
  classification: string | null;
  stage: string | null;
  inbound: number;
  /** Mensagens enviadas pela IA (sem contar o template de abertura da automação). */
  aiReplies: number;
  messages: LiveLogMessage[];
  expiresAt: Date;
}

const LiveLogSchema = new Schema<LiveLogDoc>(
  {
    _id: { type: String, required: true },
    sessionId: { type: String, index: true },
    kitKey: { type: String, index: true },
    leadId: { type: String, index: true },
    leadUrl: String,
    phone: String,
    name: String,
    startedAt: Date,
    lastAt: Date,
    status: String,
    classification: String,
    stage: String,
    inbound: Number,
    aiReplies: Number,
    messages: { type: Schema.Types.Mixed, default: [] },
    expiresAt: { type: Date, required: true },
  },
  { minimize: false, versionKey: false },
);
LiveLogSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
LiveLogSchema.index({ kitKey: 1, startedAt: -1 });

export const LiveLogModel = model<LiveLogDoc>('LiveLog', LiveLogSchema, 'live_logs');
