// Snapshot da conversa real em `live_logs` (auditoria de 7 dias). Chamado a cada gravação da sessão.
import { PlaygroundSessionModel } from '../db/models/PlaygroundSession';
import { LIVE_LOG_TTL_DAYS, LiveLogModel, type LiveLogMessage } from '../db/models/LiveLog';
import { LiveStatsModel, type LiveStatsAudio, type LiveStatsUsage } from '../db/models/LiveStats';
import { audioCostUsd, tokensCostUsd, usageFromRaw } from '../providers/pricing';
import type { Session } from './simulator';

const DAY_MS = 86_400_000;

export const liveLogId = (s: Session) => `${s.id}_${Date.parse(s.live?.startedAt ?? '') || 0}`;

export function liveLogDoc(s: Session) {
  const live = s.live!;
  const msgs = s.messages ?? [];
  const firstUser = msgs.findIndex((m) => m.role === 'user');
  const last = msgs.length ? Date.parse(msgs[msgs.length - 1].createdAt) || Date.now() : Date.now();
  const nome = s.customFields?.nome;
  return {
    _id: liveLogId(s),
    sessionId: s.id,
    kitKey: live.kitKey,
    leadId: live.leadId,
    leadUrl: live.leadId && live.portal ? `${live.portal}/crm/lead/details/${live.leadId}/` : null,
    phone: s.phone,
    name: typeof nome === 'string' && nome.trim() ? nome.trim() : null,
    startedAt: new Date(live.startedAt),
    lastAt: new Date(last),
    status: s.state?.status ?? null,
    classification: s.state?.classification ?? null,
    stage: s.crm?.stageId ?? null,
    inbound: msgs.filter((m) => m.role === 'user').length,
    // IA "atuou" = respondeu depois que o lead escreveu (o template de abertura não conta)
    aiReplies: firstUser < 0 ? 0 : msgs.slice(firstUser).filter((m) => m.role === 'assistant').length,
    messages: msgs.map((m): LiveLogMessage => ({
      role: m.role, type: m.type, body: m.body ?? '', transcript: m.transcript ?? null, mediaPath: m.mediaPath ?? null,
      createdAt: m.createdAt, ...(m.event ? { event: m.event } : {}),
    })),
    expiresAt: new Date(last + LIVE_LOG_TTL_DAYS * DAY_MS),
  };
}

/** Resumo permanente (relatório de custos): tokens por etapa+modelo, áudio, contagem de mensagens e desfecho. */
export function liveStatsDoc(s: Session) {
  const log = liveLogDoc(s);
  const usage = new Map<string, LiveStatsUsage>();
  for (const l of s.logs ?? []) {
    const u = usageFromRaw(l.raw) ?? { input: 0, output: 0, cached: 0 };
    const k = `${l.step}|${l.model}`;
    const g = usage.get(k) ?? { step: l.step, model: l.model, calls: 0, input: 0, output: 0, cached: 0, usd: 0 };
    g.calls++; g.input += u.input; g.output += u.output; g.cached += u.cached;
    const c = tokensCostUsd(l.model, u);
    g.usd = c === null || g.usd === null ? null : g.usd + c;
    usage.set(k, g);
  }
  const audio = new Map<string, LiveStatsAudio>();
  for (const a of s.audioUsage ?? []) {
    const g = audio.get(a.model) ?? { model: a.model, seconds: 0, usd: 0 };
    g.seconds += a.seconds;
    const c = audioCostUsd(a.model, a.seconds);
    g.usd = c === null || g.usd === null ? null : g.usd + c;
    audio.set(a.model, g);
  }
  return {
    _id: log._id, sessionId: log.sessionId, kitKey: log.kitKey, leadId: log.leadId, leadUrl: log.leadUrl,
    phone: log.phone, name: log.name, startedAt: log.startedAt, lastAt: log.lastAt,
    status: log.status, classification: log.classification, handoffReason: s.state?.handoffReason ?? null,
    inbound: log.inbound, aiReplies: log.aiReplies,
    outbound: (s.messages ?? []).filter((m) => m.role === 'assistant').length,
    usage: [...usage.values()], audio: [...audio.values()], updatedAt: new Date(),
  };
}

export async function saveLiveLog(s: Session): Promise<void> {
  if (!s.live) return;
  const doc = liveLogDoc(s);
  const stats = liveStatsDoc(s);
  await Promise.all([
    LiveLogModel.replaceOne({ _id: doc._id }, doc, { upsert: true }),
    LiveStatsModel.replaceOne({ _id: stats._id }, stats, { upsert: true }),
  ]);
}

/** Subida: toda conversa real ainda gravada sem resumo de custo (ex: anteriores a este recurso). */
export async function backfillLiveStats(): Promise<number> {
  const docs = await PlaygroundSessionModel.find({ 'data.live': { $type: 'object' } }).lean();
  let n = 0;
  for (const d of docs) {
    const s = { ...(d.data as Omit<Session, 'id'>), id: d._id } as Session;
    if (await LiveStatsModel.exists({ _id: liveLogId(s) })) continue;
    const stats = liveStatsDoc(s);
    await LiveStatsModel.replaceOne({ _id: stats._id }, stats, { upsert: true });
    n++;
  }
  return n;
}

/** Subida: conversas reais recentes que ainda não têm log (ex: anteriores a este recurso). */
export async function backfillLiveLogs(): Promise<number> {
  const since = new Date(Date.now() - LIVE_LOG_TTL_DAYS * DAY_MS);
  const docs = await PlaygroundSessionModel.find({ 'data.live': { $type: 'object' }, updatedAt: { $gte: since } }).lean();
  let n = 0;
  for (const d of docs) {
    const s = { ...(d.data as Omit<Session, 'id'>), id: d._id } as Session;
    if (await LiveLogModel.exists({ _id: liveLogId(s) })) continue;
    await saveLiveLog(s);
    n++;
  }
  return n;
}
