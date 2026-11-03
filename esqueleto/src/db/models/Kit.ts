// Coleção `kits`: um documento por kit. `data` é o kit.json inteiro, com o system_prompt embutido.
import { Schema, model } from 'mongoose';

export interface KitDoc {
  _id: string; // kit.key
  data: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

const KitSchema = new Schema<KitDoc>(
  { _id: { type: String, required: true }, data: { type: Schema.Types.Mixed, required: true } },
  { timestamps: true, minimize: false, versionKey: false },
);

export const KitModel = model<KitDoc>('Kit', KitSchema, 'kits');
