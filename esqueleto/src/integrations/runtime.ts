// Rotas e orquestração da integração (canal + CRM) por agente.
//   POST /hooks/falefacil/:hook        ← webhook do Fale Fácil (aba Desenvolvedor da conexão)
//   GET|POST /hooks/bitrix/:hook/lead  ← robô "Webhook" do Bitrix (?id={{ID}}) ou webhook de saída ONCRMLEADADD
//   GET  /pub/f/:exp/:sig/*key         ← arquivo público temporário (mídia que o Fale Fácil baixa para enviar)
//   /api/agents/:key/integration/...   ← painel (admin): segredos, teste, catálogo do Bitrix, conversas
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { createSession, deleteSession, type Session, type SimMessage } from '../adapters/simulator';
import { objectKeyFor, putObject, sendObject } from '../adapters/storage';
import { PlaygroundSessionModel } from '../db/models/PlaygroundSession';
import { redis } from '../db/connection';
import { fireCrm } from '../engine/crm';
import { intake } from '../engine/runTurn';
import { openingTemplate, openWithTemplate, templateHistoryText } from '../engine/templates';
import type { Agent, StoredMessage, TurnContext } from '../engine/types';
import { bitrix, BitrixError, normalizeWebhookUrl, type Bitrix } from './bitrix';
import { faleFacil, normalizeWebhook } from './falefacil';
import { buildLiveContext, kitStageFor, leadKnownFields, liveSessionId, type LiveClients } from './live';
import { canonicalPhone, samePhone } from './phone';
import { getSecrets, kitKeyByHookToken, maskedSecrets, regenerateHookToken, setSecrets } from './secrets';
import { integrationOf, type InboundMessage, type IntegrationConfig } from './types';

export interface RuntimeDeps {
  agentFor(key: string): Promise<{ raw: Record<string, any>; agent: Agent }>;
  sessions: { get(id: string): Promise<Session | null>; add(s: Session): Promise<Session>; delete(id: string): Promise<void> };
  /** Contexto do simulador (registro na Session + pacing). */
  baseContext(s: Session): Promise<TurnContext>;
  scheduleTurn(s: Session, delayMs: number): void;
  /** Recalcula o próximo follow-up e grava/publica a sessão. */
  afterSend(s: Session): Promise<void>;
  transcribe(audio: Buffer, mime: string): Promise<{ text: string | null; seconds?: number | null; model?: string }>;
}

const OPENING_FALLBACK_LINE = '[Template de abertura enviado pela automação do CRM]';

// ---------- arquivo público temporário ----------
const FILE_SECRET = process.env.FILE_URL_SECRET || randomBytes(24).toString('hex');
const FILE_TTL_S = 6 * 60 * 60;
let PUBLIC_BASE = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
const sign = (exp: string, key: string) => createHmac('sha256', FILE_SECRET).update(`${exp}:${key}`).digest('base64url').slice(0, 32);

function rememberBase(req: express.Request) {
  if (!process.env.PUBLIC_BASE_URL && req.get('host')) PUBLIC_BASE = `${req.protocol}://${req.get('host')}`;
}

export function createRuntime(deps: RuntimeDeps) {
  const router = express.Router();

  // ---------- clientes por agente ----------
  async function clientsFor(kitKey: string): Promise<LiveClients> {
    const sec = await getSecrets(kitKey);
    if (!sec.falefacil_api_key) throw new Error('API key do Fale Fácil não salva.');
    if (!sec.bitrix_webhook_url) throw new Error('Webhook do Bitrix não salvo.');
    return { ff: faleFacil(sec.falefacil_api_key), bx: bitrix(sec.bitrix_webhook_url) };
  }

  const publicUrlFor = (kitKey: string) => (path: string) => {
    const key = objectKeyFor(path, kitKey);
    if (!key) throw new Error(`Arquivo inválido: ${path}`);
    if (!PUBLIC_BASE) throw new Error('PUBLIC_BASE_URL não definida (URL pública do servidor, para o Fale Fácil baixar a mídia).');
    const exp = String(Math.floor(Date.now() / 1000) + FILE_TTL_S);
    return `${PUBLIC_BASE}/pub/f/${exp}/${sign(exp, key)}/${key.split('/').map(encodeURIComponent).join('/')}`;
  };

  /** Contexto da conversa real (o servidor chama no lugar do contexto do simulador). */
  async function liveContext(s: Session, base: TurnContext): Promise<TurnContext> {
    const kitKey = s.live!.kitKey;
    const { raw, agent } = await deps.agentFor(kitKey);
    const cfg = integrationOf(raw);
    if (!cfg) throw new Error('Agente sem integração configurada.');
    return buildLiveContext(s, agent, base, cfg, await clientsFor(kitKey), { publicUrl: publicUrlFor(kitKey) });
  }

  // uma fila por conversa: mensagens seguidas do mesmo número não criam duas sessões
  const locks = new Map<string, Promise<unknown>>();
  function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    locks.set(key, next);
    next.finally(() => { if (locks.get(key) === next) locks.delete(key); }).catch(() => {});
    return next;
  }

  const allowedPhone = (cfg: IntegrationConfig, phone: string) => !cfg.test_phones.length || cfg.test_phones.some((p) => samePhone(p, phone));

  /** Nova conversa a partir do lead do CRM (dados do formulário viram dados conhecidos). */
  async function newLiveSession(kitKey: string, cfg: IntegrationConfig, bx: Bitrix, lead: Record<string, any>, phone: string): Promise<Session> {
    const known = leadKnownFields(lead, cfg, await bx.fields());
    const s = createSession(kitKey, phone, known);
    deleteSession(s.id); // o mapa em memória do simulador não guarda conversas reais
    s.id = liveSessionId(kitKey, phone);
    s.live = { kitKey, leadId: String(lead.ID), portal: bx.portal, startedAt: new Date().toISOString() };
    const stage = kitStageFor(cfg, lead.STATUS_ID);
    s.state.crmStage = stage;
    s.crm.stageId = stage;
    await deps.sessions.delete(s.id).catch(() => {});
    await deps.sessions.add(s);
    return s;
  }

  async function findLead(bx: Bitrix, phone: string): Promise<Record<string, any> | null> {
    // o Canal Aberto cria o lead quando a 1ª mensagem chega: espera um pouco se ainda não existe
    for (let i = 0; i < 3; i++) {
      const id = await bx.findLeadByPhone(phone);
      if (id) return bx.getLead(id);
      await new Promise((r) => setTimeout(r, 4000));
    }
    return null;
  }

  async function storeMedia(kitKey: string, url: string, fallbackMime: string): Promise<{ path: string; data: Buffer; mime: string } | null> {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!r.ok) return null;
      const data = Buffer.from(await r.arrayBuffer());
      const mime = (r.headers.get('content-type') ?? fallbackMime).split(';')[0].trim();
      const ext = mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'bin';
      const path = `live/${kitKey}/${Date.now()}-${randomBytes(3).toString('hex')}.${ext}`;
      await putObject(path, data, mime);
      return { path, data, mime };
    } catch {
      return null;
    }
  }

  /** Mensagem da lead → registro na Session (arquivo baixado/transcrito quando o link vem no webhook). */
  async function appendInbound(s: Session, kitKey: string, msg: InboundMessage): Promise<SimMessage> {
    const base: Partial<StoredMessage> = { externalId: msg.id || null };
    const url = msg.media?.url;
    const push = (m: Partial<SimMessage>) => {
      const full = { direction: 'inbound', role: 'user', createdAt: new Date().toISOString(), body: '', ...base, ...m, id: String(++s.seq).padStart(8, '0') } as SimMessage;
      s.messages.push(full);
      return full;
    };
    if (msg.type === 'text') return push({ type: 'text', body: msg.text });
    if (msg.type === 'audio') {
      const f = url ? await storeMedia(kitKey, url, msg.media?.mime ?? 'audio/ogg') : null;
      const m = push({ type: 'audio', mediaPath: f?.path ?? null });
      if (f) {
        const t = await deps.transcribe(f.data, f.mime);
        m.transcript = t.text;
        if (t.seconds) s.audioUsage.push({ model: t.model ?? 'whisper', seconds: t.seconds, messageId: m.id });
      }
      return m;
    }
    if (msg.type === 'image' || msg.type === 'document' || msg.type === 'video') {
      const f = url ? await storeMedia(kitKey, url, msg.media?.mime ?? 'application/octet-stream') : null;
      const type = msg.type === 'document' && f && !/pdf/.test(f.mime) && f.mime.startsWith('image/') ? 'image' : msg.type;
      const m = push({ type, body: msg.text, mediaPath: f?.path ?? null }) as SimMessage & { fileName?: string };
      if (msg.media?.filename) m.fileName = msg.media.filename;
      return m;
    }
    return push({ type: msg.type === 'reaction' ? 'reaction' : 'sticker', body: msg.text });
  }

  async function handleInbound(kitKey: string, msg: InboundMessage): Promise<void> {
    if (msg.fromMe || msg.isGroup || !msg.from) return;
    if (msg.id && !(await redis.set(`ff:msg:${msg.id}`, '1', 'EX', 2 * 86400, 'NX'))) return; // repetido
    const { raw, agent } = await deps.agentFor(kitKey);
    const cfg = integrationOf(raw);
    if (!cfg?.enabled) return;
    const phone = canonicalPhone(msg.from);
    if (!phone || !allowedPhone(cfg, phone)) return;

    await withLock(`${kitKey}:${phone}`, async () => {
      const clients = await clientsFor(kitKey);
      let s = await deps.sessions.get(liveSessionId(kitKey, phone));
      let opened = false;
      if (!s) {
        const lead = await findLead(clients.bx, phone);
        if (!lead) {
          console.warn(`[integração ${kitKey}] ${phone}: lead não encontrado no Bitrix, mensagem ignorada`);
          return;
        }
        s = await newLiveSession(kitKey, cfg, clients.bx, lead, phone);
        opened = true;
        // automação do CRM já mandou o template: entra no histórico (a IA sabe o que foi dito)
        if (cfg.opening_mode === 'external' && (await clients.bx.sentByAutomation(lead.ID).catch(() => false))) {
          const tpl = openingTemplate(agent);
          const base = await deps.baseContext(s);
          await base.channel.sendText(tpl ? templateHistoryText(tpl, s.customFields) : OPENING_FALLBACK_LINE);
          await base.store.saveState({ openedByTemplate: true });
        }
      }
      const m = await appendInbound(s, kitKey, msg);
      const ctx = await liveContext(s, await deps.baseContext(s));
      if (opened && s.state.openedByTemplate) await fireCrm(ctx, 'atendimento_iniciado');
      if (s.state.status !== 'active') { await deps.afterSend(s); return; } // equipe atendendo
      const decision = await intake(ctx, m, true);
      await deps.afterSend(s);
      if (decision === 'schedule') deps.scheduleTurn(s, Math.max(1, agent.debounce_seconds) * 1000);
    });
  }

  /** Lead entrou no CRM (motor abre a conversa com o template). */
  async function handleLeadEvent(kitKey: string, leadId: string): Promise<string> {
    const { raw, agent } = await deps.agentFor(kitKey);
    const cfg = integrationOf(raw);
    if (!cfg?.enabled) return 'integração desligada';
    if (cfg.opening_mode !== 'engine') return 'abertura feita pela automação do CRM (modo externo)';
    const tpl = openingTemplate(agent);
    if (!tpl) return 'sem template de abertura';
    const clients = await clientsFor(kitKey);
    const lead = await clients.bx.getLead(leadId);
    if (!lead) return 'lead não encontrado';
    const raw0 = lead.PHONE?.[0]?.VALUE;
    const phone = canonicalPhone(raw0);
    if (!phone) {
      await clients.bx.comment(leadId, '⚠️ IA: lead sem telefone, atendimento não iniciado.').catch(() => {});
      return 'lead sem telefone';
    }
    if (!allowedPhone(cfg, phone)) return 'telefone fora da lista de teste';
    return withLock(`${kitKey}:${phone}`, async () => {
      const cur = await deps.sessions.get(liveSessionId(kitKey, phone));
      if (cur?.live?.leadId === String(lead.ID) && cur.state.openedByTemplate) return 'já iniciado';
      const s = await newLiveSession(kitKey, cfg, clients.bx, lead, phone);
      await openWithTemplate(await liveContext(s, await deps.baseContext(s)), tpl);
      await deps.afterSend(s);
      return 'template enviado';
    });
  }

  // ---------- webhooks (públicos) ----------

  router.post('/hooks/falefacil/:hook', async (req, res) => {
    const kitKey = await kitKeyByHookToken(String(req.params.hook));
    if (!kitKey) return res.sendStatus(404);
    const sec = await getSecrets(kitKey);
    const got = String(req.get('x-webhook-token') ?? '');
    if (sec.falefacil_webhook_token && !safeEq(got, sec.falefacil_webhook_token)) return res.sendStatus(403);
    rememberBase(req);
    res.sendStatus(200); // responde já (limite de 10 s do Fale Fácil); processa em seguida
    const msg = normalizeWebhook(req.body);
    if (!msg) return;
    handleInbound(kitKey, msg).catch((e) => console.error(`[integração ${kitKey}] mensagem de ${msg.from}`, e));
  });

  router.all('/hooks/bitrix/:hook/lead', express.urlencoded({ extended: true }), async (req, res) => {
    const kitKey = await kitKeyByHookToken(String(req.params.hook));
    if (!kitKey) return res.sendStatus(404);
    rememberBase(req);
    const body: any = req.body ?? {};
    const id = String(req.query.id ?? body.id ?? body.data?.FIELDS?.ID ?? body['data[FIELDS][ID]'] ?? '').replace(/\D/g, '');
    if (!id) return res.status(400).json({ error: 'id do lead ausente (use ?id={{ID}})' });
    try {
      res.json({ ok: true, result: await handleLeadEvent(kitKey, id) });
    } catch (e) {
      console.error(`[integração ${kitKey}] lead ${id}`, e);
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.get('/pub/f/:exp/:sig/*key', async (req, res) => {
    const exp = String(req.params.exp);
    const key = ([] as string[]).concat((req.params as any).key ?? []).join('/');
    if (Number(exp) * 1000 < Date.now() || !safeEq(String(req.params.sig), sign(exp, key))) return res.sendStatus(403);
    await sendObject(key, req, res);
  });

  // ---------- painel (admin) ----------

  const wrap = (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => fn(req, res).catch(next);

  async function info(kitKey: string, req: express.Request) {
    await deps.agentFor(kitKey); // 404 se não existe
    const sec = await getSecrets(kitKey);
    const origin = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    return {
      secrets: maskedSecrets(sec),
      urls: {
        falefacil_webhook: `${origin}/hooks/falefacil/${sec.hook_token}`,
        bitrix_lead_webhook: `${origin}/hooks/bitrix/${sec.hook_token}/lead?id={{ID}}`,
      },
      public_base: PUBLIC_BASE || null,
    };
  }

  router.get('/api/agents/:key/integration', wrap(async (req, res) => {
    rememberBase(req);
    res.json(await info(String(req.params.key), req));
  }));

  router.put('/api/agents/:key/integration/secrets', wrap(async (req, res) => {
    const key = String(req.params.key);
    const b = req.body ?? {};
    if (b.bitrix_webhook_url) {
      try { b.bitrix_webhook_url = normalizeWebhookUrl(String(b.bitrix_webhook_url)); } catch (e) { return res.status(400).json({ error: (e as Error).message }); }
    }
    await setSecrets(key, {
      falefacil_api_key: b.falefacil_api_key, falefacil_webhook_token: b.falefacil_webhook_token, bitrix_webhook_url: b.bitrix_webhook_url,
    });
    res.json(await info(key, req));
  }));

  router.post('/api/agents/:key/integration/regenerate', wrap(async (req, res) => {
    const key = String(req.params.key);
    await regenerateHookToken(key);
    res.json(await info(key, req));
  }));

  /** Testa as duas pontas: conexão do Fale Fácil e acesso ao Bitrix. */
  router.post('/api/agents/:key/integration/test', wrap(async (req, res) => {
    const sec = await getSecrets(String(req.params.key));
    const out: Record<string, { ok: boolean; detail: string }> = {};
    if (sec.falefacil_api_key) {
      try {
        const st: any = await faleFacil(sec.falefacil_api_key).status();
        out.falefacil = { ok: st.status === 'connected' || st.status === 'active', detail: `${st.phone ?? ''} · ${st.provider ?? ''} · ${st.status ?? ''}` };
      } catch (e) { out.falefacil = { ok: false, detail: (e as Error).message }; }
    } else out.falefacil = { ok: false, detail: 'API key não salva' };
    if (sec.bitrix_webhook_url) {
      try {
        const r: any = await bitrix(sec.bitrix_webhook_url).call('crm.status.list', { filter: { ENTITY_ID: 'STATUS' } });
        out.bitrix = { ok: true, detail: `${(r.result ?? []).length} etapas de lead` };
      } catch (e) { out.bitrix = { ok: false, detail: (e as Error).message }; }
    } else out.bitrix = { ok: false, detail: 'Webhook não salvo' };
    res.json(out);
  }));

  /** Etapas, usuários, campos e filas do Bitrix para os seletores do painel. */
  router.get('/api/agents/:key/integration/catalog', wrap(async (req, res) => {
    const sec = await getSecrets(String(req.params.key));
    if (!sec.bitrix_webhook_url) return res.status(400).json({ error: 'Salve o webhook do Bitrix primeiro.' });
    try {
      res.json(await bitrix(sec.bitrix_webhook_url).catalog());
    } catch (e) {
      res.status(e instanceof BitrixError ? 502 : 500).json({ error: (e as Error).message });
    }
  }));

  /** Templates aprovados na conta (só para conferir nome/texto; o cadastro é manual). */
  router.get('/api/agents/:key/integration/templates', wrap(async (req, res) => {
    const sec = await getSecrets(String(req.params.key));
    if (!sec.falefacil_api_key) return res.status(400).json({ error: 'Salve a API key do Fale Fácil primeiro.' });
    try { res.json({ templates: await faleFacil(sec.falefacil_api_key).listTemplates() }); } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  }));

  /** Conversas reais do agente (monitor). */
  router.get('/api/agents/:key/integration/conversations', wrap(async (req, res) => {
    const docs = await PlaygroundSessionModel.find({ agentId: String(req.params.key), 'data.live': { $type: 'object' } })
      .sort({ updatedAt: -1 }).limit(100).lean();
    res.json({
      conversations: docs.map((d) => {
        const s = d.data as Omit<Session, 'id'>;
        const last = [...(s.messages ?? [])].reverse().find((m) => m.role !== 'event');
        return {
          id: d._id, phone: d.phone, leadId: s.live?.leadId ?? null,
          leadUrl: s.live?.leadId && s.live.portal ? `${s.live.portal}/crm/lead/details/${s.live.leadId}/` : null,
          status: s.state?.status, classification: s.state?.classification ?? null, stage: s.crm?.stageId ?? null,
          messages: (s.messages ?? []).filter((m) => m.role !== 'event').length,
          last: last ? { role: last.role, body: (last.transcript ?? last.body ?? '').slice(0, 140), type: last.type } : null,
          updatedAt: d.updatedAt,
        };
      }),
    });
  }));

  /** Apaga a conversa real (a próxima mensagem recomeça do zero). Não mexe no Bitrix nem no WhatsApp. */
  router.delete('/api/agents/:key/integration/conversations/:id', wrap(async (req, res) => {
    const id = String(req.params.id);
    if (!id.startsWith(`live_${String(req.params.key)}_`)) return res.sendStatus(404);
    await deps.sessions.delete(id);
    res.json({ ok: true });
  }));

  return { router, liveContext, handleInbound, handleLeadEvent };
}

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
