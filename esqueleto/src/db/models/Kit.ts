// Coleção `kits`: um documento por agente. `data` é o kit.json inteiro, com o system_prompt embutido.
// `publicLink` fica fora de `data` para o editor (que salva `data` inteiro) nunca sobrescrever o link.
import { Schema, model } from 'mongoose';

export interface PublicLink {
  enabled: boolean;
  /** Parte aleatória da URL pública (/t/<token>). Trocar o token invalida o link antigo. */
  token: string | null;
}

export interface KitDoc {
  _id: string; // kit.key
  data: Record<string, any>;
  publicLink: PublicLink;
  createdAt: Date;
  updatedAt: Date;
}

const KitSchema = new Schema<KitDoc>(
  {
    _id: { type: String, required: true },
    data: { type: Schema.Types.Mixed, required: true },
    publicLink: {
      enabled: { type: Boolean, default: false },
      token: { type: String, default: null },
    },
  },
  { timestamps: true, minimize: false, versionKey: false },
);
// único só entre tokens existentes (vários agentes sem link têm token null)
KitSchema.index({ 'publicLink.token': 1 }, { unique: true, partialFilterExpression: { 'publicLink.token': { $type: 'string' } } });

export const KitModel = model<KitDoc>('Kit', KitSchema, 'kits');
