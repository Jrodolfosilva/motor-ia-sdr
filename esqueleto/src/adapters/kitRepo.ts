// Config do agente (kit) no MongoDB. Na 1ª subida importa o kit.json do disco (e a pasta media/ para o MinIO).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { KitModel } from '../db/models/Kit';
import { putObject } from './storage';
import { mimeForPath } from './mediaFiles';

const EXTRA_MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.webm': 'audio/webm',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime',
};
const mimeFor = (f: string) => EXTRA_MIME[extname(f).toLowerCase()] ?? mimeForPath(f);

/** kit.json do disco com o system_prompt embutido (sem system_prompt_file). */
export function readKitJson(kitJsonPath: string): Record<string, any> {
  const raw = JSON.parse(readFileSync(kitJsonPath, 'utf8'));
  const file = raw.agent?.system_prompt_file;
  if (raw.agent && raw.agent.system_prompt == null && file) {
    raw.agent.system_prompt = readFileSync(join(dirname(kitJsonPath), file), 'utf8');
  }
  if (raw.agent) delete raw.agent.system_prompt_file;
  return raw;
}

/** Garante o kit no banco (importa do arquivo se não existir). Retorna a chave do kit ativo. */
export async function ensureKit(kitJsonPath: string, kitKey?: string): Promise<string> {
  if (kitKey && (await KitModel.exists({ _id: kitKey }))) return kitKey;
  if (!existsSync(kitJsonPath)) {
    if (kitKey) throw new Error(`Kit "${kitKey}" não está no MongoDB e ${kitJsonPath} não existe para importar.`);
    const first = await KitModel.findOne().lean();
    if (!first) throw new Error(`Nenhum kit no MongoDB e ${kitJsonPath} não existe para importar.`);
    return first._id;
  }
  const raw = readKitJson(kitJsonPath);
  const key: string = kitKey ?? raw.key;
  if (await KitModel.exists({ _id: key })) return key;

  const mediaDir = join(dirname(kitJsonPath), 'media');
  if (existsSync(mediaDir)) {
    for (const f of readdirSync(mediaDir)) {
      await putObject(`kits/${key}/media/${f}`, readFileSync(join(mediaDir, f)), mimeFor(f));
    }
  }
  await KitModel.create({ _id: key, data: { ...raw, key } });
  console.log(`Kit "${key}" importado de ${kitJsonPath} para o MongoDB`);
  return key;
}

export async function getKit(key: string): Promise<Record<string, any>> {
  const doc = await KitModel.findById(key).lean();
  if (!doc) throw new Error(`Kit "${key}" não encontrado no MongoDB`);
  return doc.data;
}

export async function saveKit(key: string, data: Record<string, any>): Promise<void> {
  await KitModel.updateOne({ _id: key }, { $set: { data: { ...data, key } } }, { upsert: true });
}
