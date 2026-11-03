// FASE 1: servidor mínimo do simulador.
//   TOGETHER_API_KEY=... npm run dev  →  http://localhost:3000
import express from 'express';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

// Carrega esqueleto/.env (se existir). Variáveis já definidas no shell têm prioridade.
const ENV_FILE = join(__dirname, '../.env');
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
import { modelFor, type Agent, type MediaAnalyzerPort } from './engine/types';
import { intake, runTurn } from './engine/runTurn';
import { openAiCompatible } from './providers/openaiCompatible';
import { appendUser, buildSimulatorContext, createSession, deleteSession, getSession, type Session, type SimMessage } from './adapters/simulator';
import { extForMime, transcribe, TRANSCRIBE_MODEL } from './providers/transcribe';
import { audioCostUsd, fxInfo, priceFor, pricesInfo, refreshFx, refreshPrices, tokensCostUsd, usageFromRaw } from './providers/pricing';
import { createMediaAnalyzer } from './engine/agents/mediaAnalyzer';
import { CRM_EVENTS } from './engine/crm';
import { localMediaFiles } from './adapters/mediaFiles';

function loadKitAgent(kitJsonPath: string, apiKey: string): Agent {
  const raw = JSON.parse(readFileSync(kitJsonPath, 'utf8'));
  const a = raw.agent;
  const systemPrompt = a.system_prompt ?? readFileSync(join(dirname(kitJsonPath), a.system_prompt_file), 'utf8');
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

const KIT = process.env.KIT_PATH ?? join(__dirname, '../../kits/salario-maternidade/kit.json');
const API_KEY = process.env.TOGETHER_API_KEY ?? '';
let agent = loadKitAgent(KIT, API_KEY);
const llm = openAiCompatible('together');

// Arquivos que o lead manda no simulador (áudio gravado, fotos, PDFs). Fase 2: storage.
const SIM_MEDIA_DIR = join(__dirname, '../.sim-media');
// Leitor de foto/PDF (docs/03 §4): visão do kit (models.vision) + texto/render de PDF.
const vision: MediaAnalyzerPort = createMediaAnalyzer(llm, localMediaFiles({ 'sim/': SIM_MEDIA_DIR }));

const app = express();
app.set('trust proxy', true); // IP real atrás de proxy (Render/Railway/Nginx) para os limites
app.use(express.json());
app.use(express.static(join(__dirname, '../public')));

// ---------- Modo público: simulador embutido na página do cliente ----------
// PUBLIC_DEMO=1 → bloqueia edição do agente/custos, esconde prompts e limita uso por IP/conversa.
// CORS_ORIGINS=https://site-do-cliente.com,https://outro.com  (padrão: * = qualquer site)

const PUBLIC_DEMO = process.env.PUBLIC_DEMO === '1';
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

const ADMIN_ROUTES = [/^\/api\/agent(\/|$)/, /^\/api\/cost\//];
app.use((req, res, next) => {
  if (PUBLIC_DEMO && ADMIN_ROUTES.some((r) => r.test(req.path))) return res.status(403).json({ error: 'Indisponível no modo público.' });
  next();
});

// script de embed + página de demonstração
app.use('/embed', express.static(join(__dirname, '../web/dist-embed'), { maxAge: '5m' }));
app.get('/demo', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Teste o atendimento com IA</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#efefed;color:#18181b}main{max-width:900px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;text-align:center;margin:8px 0 4px}p{text-align:center;color:#71717a;margin:0 0 16px}</style></head>
<body><main><h1>Teste o atendimento com IA</h1><p>Converse como se fosse a cliente: texto, áudio, foto ou PDF.</p>
<div id="hub-ia-simulador"></div></main>
<script src="/embed/hub-ia-simulador.js"></script></body></html>`);
});

// limites do modo público (memória; Fase 2: Redis)
const sessionHits = new Map<string, number[]>();
function allowNewSession(ip: string): boolean {
  if (!PUBLIC_DEMO) return true;
  const now = Date.now();
  const hits = (sessionHits.get(ip) ?? []).filter((t) => now - t < 60 * 60 * 1000);
  if (hits.length >= DEMO_MAX_SESSIONS) return false;
  hits.push(now);
  sessionHits.set(ip, hits);
  return true;
}
const tooManyMessages = (s: Session) =>
  PUBLIC_DEMO && s.messages.filter((m) => m.role === 'user').length >= DEMO_MAX_MESSAGES;
const LIMIT_MSG = 'Limite de mensagens desta conversa de teste atingido. Clique em "Recomeçar".';

app.get('/api/public/agent', (_req, res) => {
  res.json({
    name: readKitFile().raw.agent?.name ?? agent.kit.name,
    documents: agent.required_documents.map((d) => ({ key: d.key, label: d.label, file_types: d.file_types, accepted: d.accepted, request_message: '' })),
    publicMode: PUBLIC_DEMO,
  });
});

// ---------- Config do agente (lê/grava o kit.json e recarrega sem reiniciar) ----------

function readKitFile() {
  const raw = JSON.parse(readFileSync(KIT, 'utf8'));
  const file = raw.agent?.system_prompt_file;
  const systemPrompt = raw.agent?.system_prompt ?? (file ? readFileSync(join(dirname(KIT), file), 'utf8') : '');
  return { raw, systemPrompt };
}

app.get('/api/agent', (_req, res) => {
  const { raw, systemPrompt } = readKitFile();
  res.json({ kitPath: KIT, hasApiKey: API_KEY !== '', kit: raw, system_prompt: systemPrompt, crmEvents: CRM_EVENTS });
});

app.put('/api/agent', (req, res) => {
  const kit = req.body?.kit;
  const systemPrompt = req.body?.system_prompt;
  if (!kit || typeof kit !== 'object' || !kit.agent || !kit.kit || typeof systemPrompt !== 'string') {
    return res.status(400).json({ error: 'Esperado { kit: { key, kit, agent }, system_prompt: string }' });
  }
  const file = kit.agent.system_prompt_file;
  if (file) {
    delete kit.agent.system_prompt;
    writeFileSync(join(dirname(KIT), file), systemPrompt, 'utf8');
  } else {
    kit.agent.system_prompt = systemPrompt;
  }
  writeFileSync(KIT, JSON.stringify(kit, null, 2) + '\n', 'utf8');
  try {
    agent = loadKitAgent(KIT, API_KEY);
  } catch (e) {
    return res.status(500).json({ error: `Salvo, mas falhou ao recarregar: ${(e as Error).message}` });
  }
  const { raw, systemPrompt: sp } = readKitFile();
  res.json({ kitPath: KIT, hasApiKey: API_KEY !== '', kit: raw, system_prompt: sp, crmEvents: CRM_EVENTS });
});

// ---------- Mídia do kit (áudios/vídeos da recepção, biblioteca) ----------
// Arquivos ficam em <pasta do kit>/media e são referenciados no kit.json como "media/<arquivo>".

const KIT_DIR = dirname(KIT);
const MEDIA_DIR = join(KIT_DIR, 'media');
const ALLOWED_MEDIA = /^(audio|video|image)\/|^application\/pdf$/;

app.post('/api/agent/media', express.raw({ type: () => true, limit: '100mb' }), (req, res) => {
  const mime = String(req.headers['content-type'] ?? '');
  if (!ALLOWED_MEDIA.test(mime)) return res.status(415).json({ error: `Tipo não suportado: ${mime || 'desconhecido'}` });
  const original = decodeURIComponent(String(req.query.name ?? 'arquivo'));
  const safe = original.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(-80);
  const fileName = `${Date.now()}-${safe}`;
  mkdirSync(MEDIA_DIR, { recursive: true });
  writeFileSync(join(MEDIA_DIR, fileName), req.body as Buffer);
  res.json({ path: `media/${fileName}`, mime, file_name: original, size: (req.body as Buffer).length });
});

app.get('/api/kit-file', (req, res) => {
  const rel = String(req.query.path ?? '');
  const full = resolve(KIT_DIR, rel);
  if (!rel || !full.startsWith(resolve(MEDIA_DIR) + sep) || !existsSync(full)) return res.sendStatus(404);
  res.sendFile(full);
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
app.get('/api/cost/baseline', async (_req, res) => {
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
});

function view(s: Session) {
  if (PUBLIC_DEMO) return { ...s, logs: [], cost: computeCost(s) }; // sem prompts para fora
  return { ...s, logs: s.logs.map(({ raw: _raw, ...l }) => l), cost: computeCost(s) };
}

// ---------- Tempo real (SSE) + fila de turnos por sessão ----------
// O turno roda em background: o lead pode escrever enquanto a IA ainda está "digitando".
// Mensagem nova no meio → o motor descarta os balões restantes e um novo turno roda em seguida.

const SIM_DEBOUNCE_MS = Number(process.env.SIM_DEBOUNCE_MS ?? 1500); // junta rajada de mensagens
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const subscribers = new Map<string, Set<express.Response>>();
const turns = new Map<string, { running: boolean; again: boolean; timer: NodeJS.Timeout | null }>();

function publish(s: Session) {
  const subs = subscribers.get(s.id);
  if (!subs?.size) return;
  const data = `data: ${JSON.stringify(view(s))}\n\n`;
  for (const res of subs) res.write(data);
}

function contextFor(s: Session) {
  return { ...buildSimulatorContext(s, agent, llm, vision, publish), pacing: { sleep } };
}

/** Agenda um turno (debounce). Se já há turno rodando, roda outro assim que ele terminar. */
function scheduleTurn(s: Session) {
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
        await runTurn(contextFor(s));
      } while (t.again && s.state.status === 'active');
    } catch (e) {
      console.error('turno falhou', e);
    } finally {
      t.running = false;
      s.typing = false;
      publish(s);
    }
  }, SIM_DEBOUNCE_MS);
}

app.get('/api/sessions/:id/stream', (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.sendStatus(404);
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify(view(s))}\n\n`);
  const set = subscribers.get(s.id) ?? new Set();
  set.add(res);
  subscribers.set(s.id, set);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); set.delete(res); });
});

app.post('/api/sessions', (req, res) => {
  if (!allowNewSession(req.ip ?? '?')) return res.status(429).json({ error: 'Muitas conversas de teste em pouco tempo. Tente de novo mais tarde.' });
  const s = createSession(agent.id, req.body?.phone, req.body?.custom_fields ?? {});
  res.json(view(s));
});

app.get('/api/sessions/:id', (req, res) => {
  const s = getSession(req.params.id);
  s ? res.json(view(s)) : res.sendStatus(404);
});

app.post('/api/sessions/:id/reset', (req, res) => {
  if (!allowNewSession(req.ip ?? '?')) return res.status(429).json({ error: 'Muitas conversas de teste em pouco tempo. Tente de novo mais tarde.' });
  const old = getSession(req.params.id);
  deleteSession(req.params.id);
  res.json(view(createSession(agent.id, old?.phone, req.body?.custom_fields ?? {})));
});

app.post('/api/sessions/:id/messages', async (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.sendStatus(404);
  if (tooManyMessages(s)) return res.status(429).json({ error: LIMIT_MSG });

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
  const s = getSession(req.params.id);
  if (!s) return res.sendStatus(404);
  if (tooManyMessages(s)) return res.status(429).json({ error: LIMIT_MSG });
  const mime = String(req.headers['content-type'] ?? '').split(';')[0].trim();
  if (!FILE_MIME.test(mime)) return res.status(415).json({ error: `Formato não suportado (${mime || 'desconhecido'}). Envie foto (PNG/JPG/WEBP), PDF ou vídeo.` });
  const data = req.body as Buffer;
  if (!data?.length) return res.status(400).json({ error: 'Arquivo vazio' });

  mkdirSync(SIM_MEDIA_DIR, { recursive: true });
  const fileName = `${s.id.slice(0, 8)}-${Date.now()}.${EXT_BY_MIME[mime]}`;
  writeFileSync(join(SIM_MEDIA_DIR, fileName), data);

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
  const ctx = contextFor(s);
  publish(s);

  if (s.state.status !== 'active') {
    await ctx.pipeline.emitEvent({ kind: 'info', message: 'A conversa já foi encerrada pela IA. Clique em "Reiniciar" para testar de novo.' });
    return res.json(view(s));
  }

  const decision = await intake(ctx, msg, true);
  if (decision === 'schedule') scheduleTurn(s);
  res.status(202).json(view(s));
}

// ---------- Áudio gravado no simulador (microfone) ----------
// Salva o arquivo, mostra o balão na hora ("transcrevendo…"), transcreve com Whisper e só então
// entra no fluxo. Sem transcrição o motor trata como mídia ilegível (passa para humano), igual produção.

app.post('/api/sessions/:id/audio', express.raw({ type: () => true, limit: '25mb' }), async (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.sendStatus(404);
  if (tooManyMessages(s)) return res.status(429).json({ error: LIMIT_MSG });
  const mime = String(req.headers['content-type'] ?? 'audio/webm');
  if (!mime.startsWith('audio/')) return res.status(415).json({ error: `Tipo não suportado: ${mime}` });
  const audio = req.body as Buffer;
  if (!audio?.length) return res.status(400).json({ error: 'Áudio vazio' });

  mkdirSync(SIM_MEDIA_DIR, { recursive: true });
  const fileName = `${s.id.slice(0, 8)}-${Date.now()}.${extForMime(mime)}`;
  writeFileSync(join(SIM_MEDIA_DIR, fileName), audio);

  const msg = appendUser(s, { type: 'audio', body: '', mediaPath: `sim/${fileName}` }) as SimMessage & { transcribing?: boolean };
  msg.transcribing = true;
  publish(s);

  const t = await transcribe(API_KEY, audio, mime);
  msg.transcribing = false;
  msg.transcript = t.text;
  if (t.seconds) s.audioUsage.push({ model: TRANSCRIBE_MODEL, seconds: t.seconds, messageId: msg.id });
  if (!t.text) {
    await contextFor(s).pipeline.emitEvent({ kind: 'info', message: `Não consegui transcrever o áudio (${t.error}).` });
  }
  return ingest(s, msg, res);
});

app.get('/api/sim-file', (req, res) => {
  const rel = String(req.query.path ?? '').replace(/^sim\//, '');
  const full = resolve(SIM_MEDIA_DIR, rel);
  if (!rel || !full.startsWith(resolve(SIM_MEDIA_DIR) + sep) || !existsSync(full)) return res.sendStatus(404);
  res.sendFile(full, { dotfiles: 'allow' }); // a pasta é ".sim-media"; o Express bloqueia dotfiles por padrão
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`Simulador em http://localhost:${port}`));
