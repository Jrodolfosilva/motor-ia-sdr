// Limite por janela fixa no Redis (modo público): até `max` ações por chave a cada `windowSec`.
import { redis } from '../db/connection';

export async function allowHit(key: string, max: number, windowSec: number): Promise<boolean> {
  const bucket = Math.floor(Date.now() / 1000 / windowSec);
  const k = `rl:${key}:${bucket}`;
  const n = await redis.incr(k);
  if (n === 1) await redis.expire(k, windowSec);
  return n <= max;
}
