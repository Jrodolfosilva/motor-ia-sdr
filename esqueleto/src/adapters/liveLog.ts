// Snapshot da conversa real em `live_logs` (auditoria de 7 dias). Chamado a cada gravação da sessão.
import { PlaygroundSessionModel } from '../db/models/PlaygroundSession';
import { LIVE_LOG_TTL_DAYS, LiveLogModel, type LiveLogMessage } from '../db/models/LiveLog';
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

export async function saveLiveLog(s: Session): Promise<void> {
  if (!s.live) return;
  const doc = liveLogDoc(s);
  await LiveLogModel.replaceOne({ _id: doc._id }, doc, { upsert: true });
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
