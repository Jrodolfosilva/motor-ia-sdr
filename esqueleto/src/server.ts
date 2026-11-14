// Servidor do simulador. Persistência: MongoDB (agentes + sessões), MinIO (arquivos), Redis (limites).
//   docker compose up   →  http://localhost:3000
import express from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Carrega esqueleto/.env (se existir). Variáveis já definidas no shell têm prioridade.
const ENV_FILE = join(__dirname, '../.env');
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
import { modelFor, type Agent, type MediaAnalyzerPort } from './engine/types';
import { intake, runTurn } from './engine/runTurn';
import { openAiCompatible } from './providers/openaiCompatible';
import { appendUser, buildSimulatorContext, createSession, type Session, type SimMessage } from './adapters/simulator';
import { extForMime, transcribe, TRANSCRIBE_MODEL } from './providers/transcribe';
import { audioCostUsd, fxInfo, priceFor, pricesInfo, refreshFx, refreshPrices, tokensCostUsd, usageFromRaw } from './providers/pricing';
import { createMediaAnalyzer } from './engine/agents/mediaAnalyzer';
import { CRM_EVENTS } from './engine/crm';
import { createMediaFiles } from './adapters/mediaFiles';
import { connectAll, disconnectAll } from './db/connection';
import {
  createKit, deleteKit, getKit, getPublicLink, KIT_SECTIONS, kitKeyByToken, listKits, NotFound, saveKit, seedKitIfEmpty, setPublicLink,
} from './adapters/kitRepo';
import { sessionRepo } from './adapters/sessionRepo';
import { getObject, objectKeyFor, putObject, sendObject } from './adapters/storage';
import { allowHit } from './adapters/rateLimit';
import { authRouter, currentUser, requireAdmin } from './auth/auth';

function kitToAgent(raw: Record<string, any>, apiKey: string): Agent {
  const a = raw.agent;
  const systemPrompt = a.system_prompt ?? '';
  return {
    id: raw.key,
    kit: { id: raw.key, name: raw.kit.name, company_info: raw.kit.company_info, faq: raw.kit.faq ?? [], media_library: raw.kit.media_library ?? [], vision_context: raw.kit.vision_context ?? null },
    provider: a.provider, apiKey, model: a.models?.responder ?? a.model, models: a.models,
    system_prompt: systemPrompt,
    reception: a.reception ?? null,
    explanation: a.explanation ?? null,
    guardrails: a.guardrails ?? null,
    crm: a.crm ?? null,
    greeting_example: a.greeting_example, consent_message: a.consent_message,
    required_fields: a.required_fields ?? [], required_documents: a.required_documents ?? [],
    classification_labels: a.classification_labels ?? [],
    handoff_message: a.handoff_message, disqualify_message: a.disqualify_message, fallback_message: a.fallback_message,
    handoff_keywords: a.handoff_keywords ?? [], max_turns: a.max_turns ?? 20, debounce_seconds: a.debounce_seconds ?? 8,
    followup_steps: a.followup_steps ?? [], followup_final_wait_minutes: a.followup_final_wait_minutes,
    log_executions: true,
    bubble_delay: a.bubble_delay ?? null,
  };
}

// Agentes: vários no MongoDB (coleção kits), cada conversa usa o agente em que foi criada.
// Banco vazio → importa este kit.json como agente inicial.
const KIT_SEED = process.env.KIT_PATH ?? join(__dirname, '../../kits/salario-maternidade/kit.json');
const API_KEY = process.env.TOGETHER_API_KEY ?? '';
const llm = openAiCompatible('together');

interface LoadedAgent { raw: Record<string, any>; agent: Agent; vision: MediaAnalyzerPort }
const loaded = new Map<string, Promise<LoadedAgent>>();

/** Agente pronto para o motor (cache; `forget` ao salvar/excluir). */
function agentFor(key: string): Promise<LoadedAgent> {
  let p = loaded.get(key);
  if (!p) {
    p = getKit(key).then((raw) => ({
      raw,
      agent: kitToAgent(raw, API_KEY),
      // Leitor de foto/PDF (docs/03 §4): visão do kit (models.vision) + texto/render de PDF. Arquivos no MinIO.
      vision: createMediaAnalyzer(llm, createMediaFiles(async (path) => {
        const k = objectKeyFor(path, key);
        return k ? getObject(k) : null;
      })),
    }));
    p.catch(() => loaded.delete(key));
    loaded.set(key, p);
  }
  return p;
}
const forget = (key: string) => loaded.delete(key);

const app = express();
app.set('trust proxy', true); // IP real atrás de proxy (Render/Railway/Nginx) para os limites
app.use(express.json());
app.use('/api/auth', authRouter);
// painel: configuração dos agentes e custos só com login (admin)
app.use(['/api/agents', '/api/cost'], requireAdmin);
// conversas: admin (painel) ou visitante do link público; prompts/logs só para quem está logado
app.use('/api/sessions', async (req, _res, next) => { try { await currentUser(req); next(); } catch (e) { next(e); } });
const isAdmin = (req: express.Request) => !!(req as any)._authUser;
// App React compilado (web/dist) quando existe (Docker); senão o chat simples de public/.
const WEB_DIST = join(__dirname, '../web/dist');
if (existsSync(WEB_DIST)) app.use(express.static(WEB_DIST));
app.use(express.static(join(__dirname, '../public')));

// ---------- Link público por agente ----------
// Cada agente tem um link /t/<token> que pode ser ligado/desligado no editor. Visitantes do link (sem
// login) só conversam com aquele agente, não veem prompts/logs e têm limite de uso por IP/conversa.
// CORS_ORIGINS=https://site-do-cliente.com,https://outro.com  (padrão: * = qualquer site, para o embed)

const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? '*').split(',').map((o) => o.trim()).filter(Boolean);
const DEMO_MAX_SESSIONS = Number(process.env.DEMO_MAX_SESSIONS_PER_HOUR ?? 20);
const DEMO_MAX_MESSAGES = Number(process.env.DEMO_MAX_MESSAGES ?? 60);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (CORS_ORIGINS.includes('*') || CORS_ORIGINS.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', CORS_ORIGINS.includes('*') ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const wrap = (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response, next: express.NextFunction) =>
    fn(req, res).catch((e) => (e instanceof NotFound ? res.status(404).json({ error: e.message }) : next(e)));

// script de embed + página pública do agente
app.use('/embed', express.static(join(__dirname, '../web/dist-embed'), { maxAge: '5m' }));

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const publicPage = (title: string, body: string) => `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#efefed;color:#18181b}main{max-width:1100px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;text-align:center;margin:8px 0 4px}p{text-align:center;color:#71717a;margin:0 0 16px}</style></head>
<body><main>${body}</main></body></html>`;

app.get('/t/:token', wrap(async (req, res) => {
  const token = String(req.params.token);
  const key = await kitKeyByToken(token);
  if (!key) {
    return res.status(404).type('html').send(publicPage('Link indisponível',
      '<h1>Link indisponível</h1><p>Este link de teste foi desativado ou não existe. Peça um link novo a quem te enviou.</p>'));
  }
  const { raw } = await agentFor(key);
  const name = String(raw.agent?.name || raw.kit?.name || 'Atendimento');
  res.type('html').send(publicPage(`Teste: ${name}`,
    `<h1>Teste o atendimento com IA</h1><p>Converse como se fosse o cliente: texto, áudio, foto ou PDF.</p>
<div id="hub-ia-simulador"></div>
<script src="/embed/hub-ia-simulador.js" data-token="${esc(token)}"></script>`));
}));

/** Visitante (sem login) só usa conversas abertas por um link público que continua ligado. */
async function canUse(req: express.Request, s: Session): Promise<boolean> {
  if (isAdmin(req)) return true;
  return !!s.publicToken && (await kitKeyByToken(s.publicToken)) === s.agentId;
}
const LINK_OFF = 'Este link de teste foi desativado.';

// limites para visitantes (Redis: janela de 1h por IP); admin não tem limite
async function allowNewSession(req: express.Request): Promise<boolean> {
  if (isAdmin(req)) return true;
  return allowHit(`sessions:${req.ip ?? '?'}`, DEMO_MAX_SESSIONS, 60 * 60);
}
const tooManyMessages = (req: express.Request, s: Session) =>
  !isAdmin(req) && s.messages.filter((m) => m.role === 'user').length >= DEMO_MAX_MESSAGES;
const LIMIT_MSG = 'Limite de mensagens desta conversa de teste atingido. Clique em "Recomeçar".';

/** O que a página pública precisa: nome, perguntas (só rótulos), documentos e lead de teste. Sem prompt/config. */
app.get('/api/public/agent', wrap(async (req, res) => {
  const key = await kitKeyByToken(String(req.query.t ?? ''));
  if (!key) return res.status(404).json({ error: LINK_OFF });
  const { raw, agent } = await agentFor(key);
  res.json({
    key,
    name: raw.agent?.name ?? agent.kit.name,
    // a pergunta (texto que a IA manda) é amigável; o label é instrução interna do extrator
    fields: agent.required_fields.map((f) => ({ key: f.key, label: f.question || f.label })),
    documents: agent.required_documents.map((d) => ({ key: d.key, label: d.label, file_types: d.file_types, accepted: d.accepted, request_message: '' })),
    test_lead: raw.agent?.test_lead ?? null,
  });
}));

// ---------- Agentes (MongoDB, coleção kits; salvar recarrega sem reiniciar) ----------

async function agentPayload(key: string) {
  const { raw } = await agentFor(key);
  const { system_prompt: systemPrompt = '', ...agentRest } = raw.agent ?? {};
  return {
    key, kitPath: `mongodb/kits/${key}`, hasApiKey: API_KEY !== '',
    kit: { ...raw, agent: agentRest }, system_prompt: systemPrompt, crmEvents: CRM_EVENTS,
    publicLink: await getPublicLink(key),
  };
}

app.get('/api/agents', wrap(async (_req, res) => {
  res.json({ agents: await listKits(), sections: KIT_SECTIONS.map(({ id, label }) => ({ id, label })) });
}));

/** Novo agente: em branco, ou a partir de outro (template) copiando só as partes escolhidas. */
app.post('/api/agents', wrap(async (req, res) => {
  const { name, from, sections, template } = req.body ?? {};
  let key: string;
  try {
    key = await createKit({ name: String(name ?? ''), from: from || null, sections: Array.isArray(sections) ? sections : undefined, template: !!template });
  } catch (e) {
    if (e instanceof NotFound) throw e;
    return res.status(400).json({ error: (e as Error).message });
  }
  res.status(201).json(await agentPayload(key));
}));

app.get('/api/agents/:key', wrap(async (req, res) => { res.json(await agentPayload(String(req.params.key))); }));

app.put('/api/agents/:key', wrap(async (req, res) => {
  const key = String(req.params.key);
  const kit = req.body?.kit;
  const systemPrompt = req.body?.system_prompt;
  if (!kit || typeof kit !== 'object' || !kit.agent || !kit.kit || typeof systemPrompt !== 'string') {
    return res.status(400).json({ error: 'Esperado { kit: { key, kit, agent }, system_prompt: string }' });
  }
  delete kit.agent.system_prompt_file;
  kit.agent.system_prompt = systemPrompt;
  try {
    kitToAgent(kit, API_KEY); // valida antes de gravar
  } catch (e) {
    return res.status(400).json({ error: `Configuração inválida: ${(e as Error).message}` });
  }
  await saveKit(key, kit);
  forget(key);
  res.json(await agentPayload(key));
}));

app.delete('/api/agents/:key', wrap(async (req, res) => {
  const key = String(req.params.key);
  try {
    await deleteKit(key);
  } catch (e) {
    if (e instanceof NotFound) throw e;
    return res.status(400).json({ error: (e as Error).message });
  }
  forget(key);
  res.json({ ok: true });
}));

/** Liga/desliga o link público ({ enabled }) ou gera uma URL nova ({ regenerate: true }). */
app.put('/api/agents/:key/public-link', wrap(async (req, res) => {
  const { enabled, regenerate } = req.body ?? {};
  res.json(await setPublicLink(String(req.params.key), {
    enabled: typeof enabled === 'boolean' ? enabled : undefined,
    regenerate: regenerate === true,
  }));
}));

// ---------- Mídia do kit (áudios/vídeos da recepção, biblioteca) ----------
// Arquivos ficam no MinIO em kits/<kit>/media/ e são referenciados no kit como "media/<arquivo>".

const ALLOWED_MEDIA = /^(audio|video|image)\/|^application\/pdf$/;

app.post('/api/agents/:key/media', express.raw({ type: () => true, limit: '100mb' }), wrap(async (req, res) => {
  const kitKey = String(req.params.key);
  await getKit(kitKey); // 404 se não existe
  const mime = String(req.headers['content-type'] ?? '');
  if (!ALLOWED_MEDIA.test(mime)) return res.status(415).json({ error: `Tipo não suportado: ${mime || 'desconhecido'}` });
  const original = decodeURIComponent(String(req.query.name ?? 'arquivo'));
  const safe = original.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(-80);
  const fileName = `${Date.now()}-${safe}`;
  await putObject(`kits/${kitKey}/media/${fileName}`, req.body as Buffer, mime);
  res.json({ path: `media/${fileName}`, mime, file_name: original, size: (req.body as Buffer).length });
}));

// ?kit=<agente>&path=media/<arquivo> (áudios/vídeos da recepção aparecem também na página pública)
app.get('/api/kit-file', async (req, res) => {
  const rel = String(req.query.path ?? '');
  const kit = String(req.query.kit ?? '');
  const key = /^[a-z0-9_]+$/.test(kit) && rel.startsWith('media/') ? objectKeyFor(rel, kit) : null;
  if (!key) return res.sendStatus(404);
  await sendObject(key, req, res);
});

// ---------- Custo da conversa (tokens → US$ → R$) ----------
// Preços: tabela oficial do Together (/v1/models). Câmbio: AwesomeAPI. Atualizados em background.

refreshPrices(API_KEY);
refreshFx();
setInterval(() => { refreshPrices(API_KEY); refreshFx(); }, 10 * 60 * 1000).unref();

const STEP_LABEL: Record<string, string> = {
  extractor: 'Extrator', qualifier: 'Classificador', responder: 'Resposta', vision: 'Leitura de arquivo', transcription: 'Transcrição de áudio',
};

function computeCost(s: Session) {
  const { rate } = fxInfo();
  const items = [
    ...s.logs.map((l) => {
      const u = usageFromRaw(l.raw) ?? { input: 0, output: 0, cached: 0 };
      return { kind: 'tokens' as const, step: l.step, label: STEP_LABEL[l.step] ?? l.step, model: l.model, ...u, seconds: 0, usd: tokensCostUsd(l.model, u) };
    }),
    ...s.audioUsage.map((a) => ({
      kind: 'audio' as const, step: 'transcription', label: STEP_LABEL.transcription, model: a.model,
      input: 0, output: 0, cached: 0, seconds: a.seconds, usd: audioCostUsd(a.model, a.seconds),
    })),
  ];
  const usd = items.reduce((t, i) => t + (i.usd ?? 0), 0);
  const models = [...new Set(items.map((i) => i.model))].map((m) => ({ model: m, price: priceFor(m) }));
  return {
    items: items.map((i) => ({ ...i, brl: i.usd === null ? null : i.usd * rate })),
    totals: {
      input: items.reduce((t, i) => t + i.input, 0),
      output: items.reduce((t, i) => t + i.output, 0),
      cached: items.reduce((t, i) => t + i.cached, 0),
      audioSeconds: items.reduce((t, i) => t + i.seconds, 0),
      usd, brl: usd * rate,
      unpriced: items.filter((i) => i.usd === null).map((i) => i.model),
    },
    fx: fxInfo(),
    prices: { ...pricesInfo(), models },
  };
}

/** Sessão como vai para o front: com custo e sem o `raw` das chamadas (pesado). */
// Base da calculadora de custo (aba "Custos"): modelos atuais do agente + preços + câmbio.
// Médias de tokens medidas na conversa real da Mariane (02/11/2026, replay anonimizado).
app.get('/api/cost/baseline', wrap(async (req, res) => {
  const { agent } = await agentFor(String(req.query.kit ?? ''));
  await Promise.all([refreshPrices(API_KEY), refreshFx()]);
  const roles = {
    extractor: modelFor(agent, 'extractor'),
    responder: modelFor(agent, 'responder'),
    vision: modelFor(agent, 'vision'),
    transcription: TRANSCRIBE_MODEL,
  };
  res.json({
    fx: fxInfo(),
    prices: pricesInfo(),
    models: Object.fromEntries(Object.entries(roles).map(([role, model]) => [role, { model, price: priceFor(model) }])),
    averages: {
      extractor: { input: 2729, output: 1059 },
      responder: { input: 4871, output: 404 },
      vision: { input: 805, output: 987 },
    },
    reference: {
      label: 'Conversa real (lead de formulário, salário-maternidade) até a passagem para a equipe',
      leadTurns: 7, aiReplies: 6, files: 2, audioMinutes: 0,
    },
  });
}));

function view(s: Session, admin = false) {
  if (!admin) return { ...s, logs: [], cost: computeCost(s) }; // sem prompts para fora
  return { ...s, logs: s.logs.map(({ raw: _raw, ...l }) => l), cost: computeCost(s) };
}

// ---------- Tempo real (SSE) + fila de turnos por sessão ----------
// O turno roda em background: o lead pode escrever enquanto a IA ainda está "digitando".
// Mensagem nova no meio → o motor descarta os balões restantes e um novo turno roda em seguida.

// SIM_FAST=1 (só no .env local, modo dev): sem debounce e sem pausa de "digitando…" entre balões
const SIM_FAST = process.env.SIM_FAST === '1';
const SIM_DEBOUNCE_MS = SIM_FAST ? 0 : Number(process.env.SIM_DEBOUNCE_MS ?? 1500); // junta rajada de mensagens
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, SIM_FAST ? 0 : ms));
const subscribers = new Map<string, Set<{ res: express.Response; admin: boolean }>>();
const turns = new Map<string, { running: boolean; again: boolean; timer: NodeJS.Timeout | null }>();

function publish(s: Session) {
  sessionRepo.touch(s);
  const subs = subscribers.get(s.id);
  if (!subs?.size) return;
  const cache: Partial<Record<'admin' | 'public', string>> = {};
  for (const sub of subs) {
    const k = sub.admin ? 'admin' : 'public';
    sub.res.write((cache[k] ??= `data: ${JSON.stringify(view(s, sub.admin))}\n\n`));
  }
}

async function contextFor(s: Session) {
  const { agent, vision } = await agentFor(s.agentId);
  return { ...buildSimulatorContext(s, agent, llm, vision, publish), pacing: { sleep } };
}

/** Agenda um turno (debounce). Se já há turno rodando, roda outro assim que ele terminar. */
function scheduleTurn(s: Session, delayMs = SIM_DEBOUNCE_MS) {
  const t = turns.get(s.id) ?? { running: false, again: false, timer: null };
  turns.set(s.id, t);
  if (t.timer) clearTimeout(t.timer);
  t.timer = setTimeout(async () => {
    t.timer = null;
    if (t.running) { t.again = true; return; }
    t.running = true;
    try {
      do {
        t.again = false;
        await runTurn(await contextFor(s));
      } while (t.again && s.state.status === 'active');
    } catch (e) {
      console.error('turno falhou', e);
    } finally {
      t.running = false;
      s.typing = false;
      publish(s);
    }
  }, delayMs);
}

/** Sessão da URL, já checando acesso. Responde 404/403 e devolve null quando não pode. */
async function sessionFor(req: express.Request, res: express.Response): Promise<Session | null> {
  const s = await sessionRepo.get(String(req.params.id));
  // conversa do painel não existe para quem não está logado
  if (!s || (!isAdmin(req) && !s.publicToken)) { res.sendStatus(404); return null; }
  if (!(await canUse(req, s))) { res.status(403).json({ error: LINK_OFF }); return null; }
  return s;
}

app.get('/api/sessions/:id/stream', async (req, res) => {
  const s = await sessionFor(req, res);
  if (!s) return;
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const sub = { res, admin: isAdmin(req) };
  res.write(`data: ${JSON.stringify(view(s, sub.admin))}\n\n`);
  const set = subscribers.get(s.id) ?? new Set();
  set.add(sub);
  subscribers.set(s.id, set);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); set.delete(sub); });
});

const TOO_MANY = 'Muitas conversas de teste em pouco tempo. Tente de novo mais tarde.';

/** Nova conversa: admin escolhe o agente ({ agent }); visitante entra pelo token do link ({ token }). */
app.post('/api/sessions', wrap(async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  let agentKey: string | null;
  if (token) {
    agentKey = await kitKeyByToken(token);
    if (!agentKey) return res.status(403).json({ error: LINK_OFF });
  } else {
    if (!isAdmin(req)) return res.status(401).json({ error: 'Login necessário.' });
    agentKey = String(req.body?.agent ?? '');
  }
  await agentFor(agentKey); // 404 se o agente não existe
  if (!(await allowNewSession(req))) return res.status(429).json({ error: TOO_MANY });
  const s = createSession(agentKey, req.body?.phone, req.body?.custom_fields ?? {});
  if (token) s.publicToken = token;
  await sessionRepo.add(s);
  res.json(view(s, isAdmin(req)));
}));

app.get('/api/sessions/:id', async (req, res) => {
  const s = await sessionFor(req, res);
  if (s) res.json(view(s, isAdmin(req)));
});

app.post('/api/sessions/:id/reset', async (req, res) => {
  const old = await sessionFor(req, res);
  if (!old) return;
  if (!(await allowNewSession(req))) return res.status(429).json({ error: TOO_MANY });
  await sessionRepo.delete(old.id);
  const s = createSession(old.agentId, old.phone, req.body?.custom_fields ?? {});
  s.publicToken = old.publicToken ?? null;
  await sessionRepo.add(s);
  res.json(view(s, isAdmin(req)));
});

// Lead de formulário: o botão "Iniciar" do simulador faz a IA abrir a conversa (sem mensagem do lead).
app.post('/api/sessions/:id/start', async (req, res) => {
  const s = await sessionFor(req, res);
  if (!s) return;
  const untouched = s.state.status === 'active' && s.state.turnsCount === 0 && !s.messages.some((m) => m.role === 'user');
  if (untouched && !turns.get(s.id)?.running) scheduleTurn(s, 0);
  res.status(202).json(view(s, isAdmin(req)));
});

app.post('/api/sessions/:id/messages', async (req, res) => {
  const s = await sessionFor(req, res);
  if (!s) return;
  if (tooManyMessages(req, s)) return res.status(429).json({ error: LIMIT_MSG });

  const body = String(req.body.body ?? '').trim();
  if (!body) return res.status(400).json({ error: 'Mensagem vazia' });
  return ingest(s, appendUser(s, { type: 'text', body }), res);
});

// ---------- Foto / PDF enviados pelo lead ----------
// Igual ao WhatsApp: o arquivo entra no fluxo e a IA lê (visão / texto do PDF) no turno.

const FILE_MIME = /^image\/(png|jpe?g|webp|gif)$|^application\/pdf$|^video\/(mp4|webm|quicktime|3gpp)$/;
const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/3gpp': '3gp',
};

app.post('/api/sessions/:id/file', express.raw({ type: () => true, limit: '50mb' }), async (req, res) => {
  const s = await sessionFor(req, res);
  if (!s) return;
  if (tooManyMessages(req, s)) return res.status(429).json({ error: LIMIT_MSG });
  const mime = String(req.headers['content-type'] ?? '').split(';')[0].trim();
  if (!FILE_MIME.test(mime)) return res.status(415).json({ error: `Formato não suportado (${mime || 'desconhecido'}). Envie foto (PNG/JPG/WEBP), PDF ou vídeo.` });
  const data = req.body as Buffer;
  if (!data?.length) return res.status(400).json({ error: 'Arquivo vazio' });

  const fileName = `${s.id.slice(0, 8)}-${Date.now()}.${EXT_BY_MIME[mime]}`;
  await putObject(`sim/${fileName}`, data, mime);

  const caption = decodeURIComponent(String(req.query.caption ?? '')).trim();
  const original = decodeURIComponent(String(req.query.name ?? '')).trim();
  const msg = appendUser(s, {
    type: mime === 'application/pdf' ? 'document' : mime.startsWith('video/') ? 'video' : 'image',
    body: caption,
    mediaPath: `sim/${fileName}`,
  }) as SimMessage & { fileName?: string };
  if (original) msg.fileName = original;
  return ingest(s, msg, res);
});

/** Mensagem do lead já registrada → intake → agenda o turno. A resposta da IA chega pelo /stream. */
async function ingest(s: Session, msg: SimMessage, res: express.Response) {
  const ctx = await contextFor(s);
  publish(s);

  if (s.state.status !== 'active') {
    await ctx.pipeline.emitEvent({ kind: 'info', message: 'A conversa já foi encerrada pela IA. Clique em "Reiniciar" para testar de novo.' });
    return res.json(view(s, isAdmin(res.req)));
  }

  const decision = await intake(ctx, msg, true);
  if (decision === 'schedule') scheduleTurn(s);
  res.status(202).json(view(s, isAdmin(res.req)));
}

// ---------- Áudio gravado no simulador (microfone) ----------
// Salva o arquivo, mostra o balão na hora ("transcrevendo…"), transcreve com Whisper e só então
// entra no fluxo. Sem transcrição o motor trata como mídia ilegível (passa para humano), igual produção.

app.post('/api/sessions/:id/audio', express.raw({ type: () => true, limit: '25mb' }), async (req, res) => {
  const s = await sessionFor(req, res);
  if (!s) return;
  if (tooManyMessages(req, s)) return res.status(429).json({ error: LIMIT_MSG });
  const mime = String(req.headers['content-type'] ?? 'audio/webm');
  if (!mime.startsWith('audio/')) return res.status(415).json({ error: `Tipo não suportado: ${mime}` });
  const audio = req.body as Buffer;
  if (!audio?.length) return res.status(400).json({ error: 'Áudio vazio' });

  const fileName = `${s.id.slice(0, 8)}-${Date.now()}.${extForMime(mime)}`;
  await putObject(`sim/${fileName}`, audio, mime.split(';')[0].trim());

  const msg = appendUser(s, { type: 'audio', body: '', mediaPath: `sim/${fileName}` }) as SimMessage & { transcribing?: boolean };
  msg.transcribing = true;
  publish(s);

  const t = await transcribe(API_KEY, audio, mime);
  msg.transcribing = false;
  msg.transcript = t.text;
  if (t.seconds) s.audioUsage.push({ model: TRANSCRIBE_MODEL, seconds: t.seconds, messageId: msg.id });
  if (!t.text) {
    await (await contextFor(s)).pipeline.emitEvent({ kind: 'info', message: `Não consegui transcrever o áudio (${t.error}).` });
  }
  return ingest(s, msg, res);
});

app.get('/api/sim-file', async (req, res) => {
  const rel = String(req.query.path ?? '');
  const key = objectKeyFor(rel.startsWith('sim/') ? rel : `sim/${rel}`, '');
  if (!key || key === 'sim/') return res.sendStatus(404);
  await sendObject(key, req, res);
});

// ---------- Subida ----------

async function main() {
  await connectAll();
  await seedKitIfEmpty(KIT_SEED);
  setInterval(() => sessionRepo.evictIdle((id) => !!turns.get(id)?.running || !!subscribers.get(id)?.size), 5 * 60 * 1000).unref();

  const port = Number(process.env.PORT ?? 3000);
  const server = app.listen(port, () => console.log(`Simulador em http://localhost:${port}`));

  const shutdown = async (sig: string) => {
    console.log(`${sig}: gravando sessões e desligando…`);
    server.close();
    await sessionRepo.flush();
    await disconnectAll();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error('Falha ao subir:', e);
  process.exit(1);
});
