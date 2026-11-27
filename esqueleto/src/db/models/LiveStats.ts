// Coleção `live_stats`: resumo de cada conversa REAL para o relatório de custos (tokens, áudio, mensagens, desfecho).
// Sem TTL: o `live_logs` (com o histórico) some em 7 dias, este resumo fica para relatórios de qualquer período.
import { Schema, model } from 'mongoose';

export interface LiveStatsUsage {
  step: string;
  model: string;
  calls: number;
  input: number;
  output: number;
  cached: number;
  /** Custo em US$ calculado na gravação (null = modelo sem preço naquele momento). */
  usd: number | null;
}

export interface LiveStatsAudio { model: string; seconds: number; usd: number | null }

export interface LiveStatsDoc {
  _id: string; // mesmo id do live_logs
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
  handoffReason: string | null;
  /** Mensagens do lead. */
  inbound: number;
  /** Mensagens da IA depois que o lead escreveu (respostas de verdade). */
  aiReplies: number;
  /** Tudo que saiu para o lead (template de abertura + respostas + follow-ups). */
  outbound: number;
  usage: LiveStatsUsage[];
  audio: LiveStatsAudio[];
  updatedAt: Date;
}

const LiveStatsSchema = new Schema<LiveStatsDoc>(
  {
    _id: { type: String, required: true },
    sessionId: String,
    kitKey: { type: String, index: true },
    leadId: String,
    leadUrl: String,
    phone: String,
    name: String,
    startedAt: Date,
    lastAt: Date,
    status: String,
    classification: String,
    handoffReason: String,
    inbound: Number,
    aiReplies: Number,
    outbound: Number,
    usage: { type: Schema.Types.Mixed, default: [] },
    audio: { type: Schema.Types.Mixed, default: [] },
    updatedAt: Date,
  },
  { minimize: false, versionKey: false },
);
LiveStatsSchema.index({ kitKey: 1, startedAt: -1 });

export const LiveStatsModel = model<LiveStatsDoc>('LiveStats', LiveStatsSchema, 'live_stats');
