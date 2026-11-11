// Agentes (kits) no MongoDB. Cada documento da coleção `kits` é um agente independente: o motor é o
// mesmo, só a configuração muda. Na 1ª subida (banco vazio) importa o kit.json do disco como agente
// inicial. Um agente pode ser marcado como template e servir de base para outros (cópia total ou
// só de algumas partes do fluxo).
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { KitModel, type PublicLink } from '../db/models/Kit';
import { copyPrefix, putObject, removePrefix } from './storage';
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

/** Banco vazio → importa o kit.json do disco (e a pasta media/ para o MinIO). */
export async function seedKitIfEmpty(kitJsonPath: string): Promise<void> {
  if (await KitModel.exists({})) return;
  if (!existsSync(kitJsonPath)) {
    console.warn(`Nenhum agente no MongoDB e ${kitJsonPath} não existe: crie um agente pelo painel.`);
    return;
  }
  const raw = readKitJson(kitJsonPath);
  const key: string = raw.key;
  const mediaDir = join(dirname(kitJsonPath), 'media');
  if (existsSync(mediaDir)) {
    for (const f of readdirSync(mediaDir)) {
      await putObject(`kits/${key}/media/${f}`, readFileSync(join(mediaDir, f)), mimeFor(f));
    }
  }
  await KitModel.create({ _id: key, data: { ...raw, key }, publicLink: { enabled: false, token: null } });
  console.log(`Agente "${key}" importado de ${kitJsonPath} para o MongoDB`);
}

export async function getKit(key: string): Promise<Record<string, any>> {
  const doc = await KitModel.findById(key).lean();
  if (!doc) throw new NotFound(`Agente "${key}" não encontrado`);
  return doc.data;
}

export async function saveKit(key: string, data: Record<string, any>): Promise<void> {
  const r = await KitModel.updateOne({ _id: key }, { $set: { data: { ...data, key } } });
  if (!r.matchedCount) throw new NotFound(`Agente "${key}" não encontrado`);
}

export class NotFound extends Error {}

// ---------- Lista / criação / exclusão ----------

export interface KitSummary {
  key: string;
  name: string;
  kitName: string;
  category: string | null;
  template: boolean;
  publicLink: PublicLink;
  updatedAt: Date;
}

export async function listKits(): Promise<KitSummary[]> {
  const docs = await KitModel.find({}, { data: 1, publicLink: 1, updatedAt: 1 }).sort({ updatedAt: -1 }).lean();
  return docs.map((d) => ({
    key: d._id,
    name: d.data?.agent?.name || d.data?.kit?.name || d._id,
    kitName: d.data?.kit?.name ?? '',
    category: d.data?.kit?.category ?? null,
    template: !!d.data?.template,
    publicLink: { enabled: !!d.publicLink?.enabled, token: d.publicLink?.token ?? null },
    updatedAt: d.updatedAt,
  }));
}

/**
 * Partes do fluxo que podem ser copiadas de um agente base. Cada parte lista os caminhos do kit que
 * leva junto. Modelos, limites e ritmo das mensagens sempre vêm da base (são técnicos, não do segmento).
 */
export const KIT_SECTIONS: { id: string; label: string; paths: string[] }[] = [
  { id: 'empresa', label: 'Empresa, biblioteca de mídia e leitor de arquivos', paths: ['kit.company_info', 'kit.media_library', 'kit.vision_context'] },
  { id: 'prompt', label: 'System prompt', paths: ['agent.system_prompt'] },
  { id: 'conduta', label: 'Conduta e limites', paths: ['agent.guardrails', 'agent.fallback_message', 'agent.handoff_keywords'] },
  { id: 'faq', label: 'FAQ', paths: ['kit.faq'] },
  { id: 'recepcao', label: '1. Recepção', paths: ['agent.reception', 'agent.greeting_example', 'agent.consent_message'] },
  { id: 'perguntas', label: '2. Perguntas', paths: ['agent.required_fields'] },
  { id: 'explicacao', label: '3. Explicação', paths: ['agent.explanation'] },
  { id: 'documentos', label: '4. Documentos', paths: ['agent.required_documents'] },
  { id: 'classificacao', label: '5. Classificação', paths: ['agent.classification_labels'] },
  { id: 'mensagens', label: '6. Encerramento', paths: ['agent.handoff_message', 'agent.disqualify_message'] },
  { id: 'followup', label: 'Follow-up', paths: ['agent.followup_steps', 'agent.followup_final_wait_minutes'] },
  { id: 'crm', label: 'CRM / Kanban', paths: ['agent.crm'] },
  { id: 'teste', label: 'Teste (lead frio e formulário de exemplo)', paths: ['agent.test_lead'] },
];
const ALWAYS_COPY = ['engine_version', 'agent.provider', 'agent.model', 'agent.models', 'agent.max_turns', 'agent.debounce_seconds', 'agent.bubble_delay'];

/** Agente vazio: motor funciona, mas sem roteiro/classificação até alguém configurar. */
export function blankKit(name: string): Record<string, any> {
  return {
    engine_version: '1',
    template: false,
    kit: { name, category: null, company_info: '', faq: [], media_library: [], vision_context: null },
    agent: {
      name,
      provider: 'together',
      models: {},
      system_prompt: `Você é ${name}, atendente pelo WhatsApp. Seja cordial, objetiva e escreva mensagens curtas.`,
      guardrails: null, reception: null, explanation: null, crm: null,
      greeting_example: null, consent_message: null,
      fallback_message: null, handoff_message: null, disqualify_message: null,
      handoff_keywords: ['atendente', 'humano', 'pessoa'],
      max_turns: 20, debounce_seconds: 8,
      required_fields: [], required_documents: [], classification_labels: [],
      followup_steps: [], followup_final_wait_minutes: null,
      test_lead: { cold_message: 'Olá, gostaria de mais informações', form_answers: {} },
    },
  };
}

const getPath = (o: any, p: string) => p.split('.').reduce((v, k) => (v == null ? undefined : v[k]), o);
function setPath(o: any, p: string, v: unknown) {
  const ks = p.split('.');
  let cur = o;
  for (const k of ks.slice(0, -1)) cur = cur[k] ??= {};
  cur[ks[ks.length - 1]] = v;
}

/** "Salário Maternidade 2" → "salario_maternidade_2", único na coleção. */
async function uniqueKey(name: string): Promise<string> {
  const base = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'agente';
  let key = base;
  for (let i = 2; await KitModel.exists({ _id: key }); i++) key = `${base}_${i}`;
  return key;
}

export async function createKit(opts: { name: string; from?: string | null; sections?: string[]; template?: boolean }): Promise<string> {
  const name = opts.name.trim();
  if (!name) throw new Error('Informe o nome do agente.');
  const key = await uniqueKey(name);
  const data = blankKit(name);
  data.template = !!opts.template;

  if (opts.from) {
    const base = await getKit(opts.from);
    const chosen = new Set(opts.sections ?? KIT_SECTIONS.map((s) => s.id));
    const paths = [...ALWAYS_COPY, ...KIT_SECTIONS.filter((s) => chosen.has(s.id)).flatMap((s) => s.paths)];
    for (const p of paths) {
      const v = getPath(base, p);
      if (v !== undefined) setPath(data, p, structuredClone(v));
    }
    if (chosen.has('empresa')) data.kit.category = base.kit?.category ?? null;
    // mídia referenciada como "media/<arquivo>" mora no prefixo do kit: copia junto
    await copyPrefix(`kits/${opts.from}/media/`, `kits/${key}/media/`);
  }

  await KitModel.create({ _id: key, data: { ...data, key }, publicLink: { enabled: false, token: null } });
  return key;
}

export async function deleteKit(key: string): Promise<void> {
  if ((await KitModel.countDocuments()) <= 1) throw new Error('Não dá para excluir o único agente.');
  const r = await KitModel.deleteOne({ _id: key });
  if (!r.deletedCount) throw new NotFound(`Agente "${key}" não encontrado`);
  await removePrefix(`kits/${key}/media/`).catch((e) => console.error(`falha ao limpar mídia de ${key}`, e));
}

// ---------- Link público ----------

const newToken = () => randomBytes(9).toString('base64url'); // 12 caracteres, não adivinhável

export async function getPublicLink(key: string): Promise<PublicLink> {
  const doc = await KitModel.findById(key, { publicLink: 1 }).lean();
  if (!doc) throw new NotFound(`Agente "${key}" não encontrado`);
  return { enabled: !!doc.publicLink?.enabled, token: doc.publicLink?.token ?? null };
}

/** Liga/desliga o link. Ao ligar pela 1ª vez (ou com `regenerate`) gera um token novo. */
export async function setPublicLink(key: string, opts: { enabled?: boolean; regenerate?: boolean }): Promise<PublicLink> {
  const cur = await getPublicLink(key);
  const next: PublicLink = {
    enabled: opts.enabled ?? cur.enabled,
    token: opts.regenerate || (!cur.token && (opts.enabled ?? cur.enabled)) ? newToken() : cur.token,
  };
  await KitModel.updateOne({ _id: key }, { $set: { publicLink: next } });
  return next;
}

/** Agente pelo token do link público. null = token desconhecido ou link desligado. */
export async function kitKeyByToken(token: string): Promise<string | null> {
  if (!token) return null;
  const doc = await KitModel.findOne({ 'publicLink.token': token, 'publicLink.enabled': true }, { _id: 1 }).lean();
  return doc?._id ?? null;
}
