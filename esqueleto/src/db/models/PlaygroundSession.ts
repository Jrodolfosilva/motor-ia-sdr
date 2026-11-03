// Coleção `playground_sessions`: conversas do simulador (estado, mensagens, logs, CRM, custo de áudio).
import { Schema, model } from 'mongoose';

export interface PlaygroundSessionDoc {
  _id: string; // Session.id
  agentId: string;
  phone: string;
  data: Record<string, any>; // Session sem o id
  createdAt: Date;
  updatedAt: Date;
}

const PlaygroundSessionSchema = new Schema<PlaygroundSessionDoc>(
  {
    _id: { type: String, required: true },
    agentId: { type: String, index: true },
    phone: { type: String },
    data: { type: Schema.Types.Mixed, required: true },
  },
  { timestamps: true, minimize: false, versionKey: false },
);

export const PlaygroundSessionModel = model<PlaygroundSessionDoc>('PlaygroundSession', PlaygroundSessionSchema, 'playground_sessions');
