// Sessões do simulador no MongoDB. O motor muta o objeto Session em memória (adapters/simulator.ts);
// aqui fica um cache das sessões ativas e cada mudança agenda uma gravação (write-behind curto).
import { PlaygroundSessionModel } from '../db/models/PlaygroundSession';
import type { Session } from './simulator';

const SAVE_DELAY_MS = 250;
const IDLE_EVICT_MS = 30 * 60 * 1000;

const cache = new Map<string, { s: Session; touched: number }>();
const pending = new Map<string, NodeJS.Timeout>();
const inflight = new Map<string, Promise<void>>();

function toDoc(s: Session) {
  const { id, ...data } = s;
  return { _id: id, agentId: s.agentId, phone: s.phone, data: { ...data, typing: false } };
}

function fromDoc(d: { _id: string; data: Record<string, any> }): Session {
  return { ...(d.data as Omit<Session, 'id'>), id: d._id };
}

/** Gravações da mesma sessão em fila (nunca uma antiga sobrescreve uma nova). */
async function write(s: Session): Promise<void> {
  const prev = inflight.get(s.id) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(async () => { await PlaygroundSessionModel.replaceOne({ _id: s.id }, toDoc(s), { upsert: true }); });
  inflight.set(s.id, next);
  try {
    await next;
  } finally {
    if (inflight.get(s.id) === next) inflight.delete(s.id);
  }
}

export const sessionRepo = {
  /** Registra sessão nova (criada em memória) e grava. */
  async add(s: Session): Promise<Session> {
    cache.set(s.id, { s, touched: Date.now() });
    await write(s);
    return s;
  },

  async get(id: string): Promise<Session | null> {
    const hit = cache.get(id);
    if (hit) {
      hit.touched = Date.now();
      return hit.s;
    }
    const doc = await PlaygroundSessionModel.findById(id).lean();
    if (!doc) return null;
    const again = cache.get(id); // outra requisição pode ter carregado enquanto esperávamos
    if (again) return again.s;
    const s = fromDoc(doc);
    cache.set(id, { s, touched: Date.now() });
    return s;
  },

  /** Agenda gravação (agrupa várias mudanças seguidas). */
  touch(s: Session): void {
    const c = cache.get(s.id);
    if (c) c.touched = Date.now();
    if (pending.has(s.id)) return;
    pending.set(s.id, setTimeout(() => {
      pending.delete(s.id);
      write(s).catch((e) => console.error(`falha ao gravar sessão ${s.id}`, e));
    }, SAVE_DELAY_MS));
  },

  async delete(id: string): Promise<void> {
    clearTimeout(pending.get(id));
    pending.delete(id);
    cache.delete(id);
    await inflight.get(id)?.catch(() => {});
    await PlaygroundSessionModel.deleteOne({ _id: id });
  },

  /** Grava tudo que está pendente (desligamento). */
  async flush(): Promise<void> {
    const ids = [...pending.keys()];
    for (const id of ids) {
      clearTimeout(pending.get(id));
      pending.delete(id);
    }
    const toWrite = ids.map((id) => cache.get(id)?.s).filter((s): s is Session => !!s);
    await Promise.allSettled(toWrite.map(write));
    await Promise.allSettled([...inflight.values()]);
  },

  /** Tira da memória sessões paradas (continuam no banco). `busy` = turno rodando. */
  evictIdle(busy: (id: string) => boolean): void {
    const now = Date.now();
    for (const [id, c] of cache) {
      if (now - c.touched > IDLE_EVICT_MS && !pending.has(id) && !inflight.has(id) && !busy(id)) cache.delete(id);
    }
  },
};
