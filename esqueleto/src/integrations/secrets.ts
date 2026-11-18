// Segredos da integração por agente (coleção `integration_secrets`), fora do kit: o editor salva o kit
// inteiro e o kit vira kit.json no git; chave de API não pode ir junto. O painel só vê se está salva
// e os 4 últimos caracteres. `hook_token` = parte aleatória das URLs de webhook deste agente.
import { randomBytes } from 'node:crypto';
import { Schema, model } from 'mongoose';
import type { IntegrationSecrets } from './types';

interface SecretsDoc extends IntegrationSecrets {
  _id: string; // kit key
  hook_token: string;
}

const SecretsSchema = new Schema<SecretsDoc>(
  {
    _id: { type: String, required: true },
    hook_token: { type: String, required: true, unique: true },
    falefacil_api_key: { type: String, default: null },
    falefacil_webhook_token: { type: String, default: null },
    bitrix_webhook_url: { type: String, default: null },
  },
  { timestamps: true, versionKey: false },
);
const SecretsModel = model<SecretsDoc>('IntegrationSecrets', SecretsSchema, 'integration_secrets');

const newToken = () => randomBytes(12).toString('base64url');
const cache = new Map<string, SecretsDoc>();

export async function getSecrets(kitKey: string): Promise<SecretsDoc> {
  const hit = cache.get(kitKey);
  if (hit) return hit;
  let doc = await SecretsModel.findById(kitKey).lean();
  if (!doc) {
    await SecretsModel.updateOne({ _id: kitKey }, { $setOnInsert: { hook_token: newToken() } }, { upsert: true });
    doc = (await SecretsModel.findById(kitKey).lean())!;
  }
  cache.set(kitKey, doc);
  return doc;
}

/** Grava só os campos enviados; string vazia apaga. */
export async function setSecrets(kitKey: string, patch: IntegrationSecrets): Promise<void> {
  await getSecrets(kitKey);
  const $set: Record<string, string | null> = {};
  for (const k of ['falefacil_api_key', 'falefacil_webhook_token', 'bitrix_webhook_url'] as const) {
    if (patch[k] !== undefined) $set[k] = patch[k]?.trim() || null;
  }
  await SecretsModel.updateOne({ _id: kitKey }, { $set });
  cache.delete(kitKey);
}

export async function regenerateHookToken(kitKey: string): Promise<void> {
  await getSecrets(kitKey);
  await SecretsModel.updateOne({ _id: kitKey }, { $set: { hook_token: newToken() } });
  cache.delete(kitKey);
}

export async function kitKeyByHookToken(token: string): Promise<string | null> {
  if (!token) return null;
  for (const [k, d] of cache) if (d.hook_token === token) return k;
  const doc = await SecretsModel.findOne({ hook_token: token }, { _id: 1 }).lean();
  return doc?._id ?? null;
}

export async function deleteSecrets(kitKey: string): Promise<void> {
  await SecretsModel.deleteOne({ _id: kitKey });
  cache.delete(kitKey);
}

const mask = (v?: string | null) => (v ? { saved: true, hint: `…${v.slice(-4)}` } : { saved: false, hint: null });

/** O que o painel pode ver. */
export function maskedSecrets(d: SecretsDoc) {
  return {
    falefacil_api_key: mask(d.falefacil_api_key),
    falefacil_webhook_token: mask(d.falefacil_webhook_token),
    // URL do Bitrix: mostra o portal, esconde o código
    bitrix_webhook_url: d.bitrix_webhook_url
      ? { saved: true, hint: d.bitrix_webhook_url.replace(/(\/rest\/\d+\/).+$/, '$1…') }
      : { saved: false, hint: null },
  };
}
