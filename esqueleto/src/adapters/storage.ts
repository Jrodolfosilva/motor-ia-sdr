// Arquivos (mídia do kit e do lead) no MinIO/S3. Chaves no bucket:
//   kits/<kitKey>/media/<arquivo>   ← referenciado no kit como "media/<arquivo>"
//   sim/<arquivo>                    ← mídia enviada no simulador, referenciada como "sim/<arquivo>"
import type { Request, Response } from 'express';
import { minio, MINIO_BUCKET } from '../db/connection';

const isNotFound = (e: any) => e?.code === 'NotFound' || e?.code === 'NoSuchKey';

export async function putObject(key: string, data: Buffer, mime: string): Promise<void> {
  await minio.putObject(MINIO_BUCKET, key, data, data.length, { 'Content-Type': mime });
}

export async function getObject(key: string): Promise<{ data: Buffer; mime: string } | null> {
  try {
    const stat = await minio.statObject(MINIO_BUCKET, key);
    const stream = await minio.getObject(MINIO_BUCKET, key);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    return { data: Buffer.concat(chunks), mime: String(stat.metaData?.['content-type'] ?? 'application/octet-stream') };
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/** Envia o objeto ao navegador com suporte a Range (seek em áudio/vídeo). */
export async function sendObject(key: string, req: Request, res: Response): Promise<void> {
  let stat;
  try {
    stat = await minio.statObject(MINIO_BUCKET, key);
  } catch (e) {
    res.sendStatus(isNotFound(e) ? 404 : 502);
    return;
  }
  const size = stat.size;
  res.setHeader('Content-Type', String(stat.metaData?.['content-type'] ?? 'application/octet-stream'));
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=300');

  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (range && (range[1] || range[2]) && size > 0) {
    let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    end = Math.min(end, size - 1);
    if (start > end) {
      res.status(416).setHeader('Content-Range', `bytes */${size}`);
      res.end();
      return;
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', String(end - start + 1));
    (await minio.getPartialObject(MINIO_BUCKET, key, start, end - start + 1)).pipe(res);
    return;
  }
  res.setHeader('Content-Length', String(size));
  (await minio.getObject(MINIO_BUCKET, key)).pipe(res);
}

/** Copia todos os objetos de um prefixo para outro (ex: mídia de um kit para o kit duplicado). */
export async function copyPrefix(from: string, to: string): Promise<number> {
  const keys: string[] = [];
  for await (const o of minio.listObjectsV2(MINIO_BUCKET, from, true)) if (o.name) keys.push(o.name);
  for (const k of keys) {
    await minio.copyObject(MINIO_BUCKET, to + k.slice(from.length), `/${MINIO_BUCKET}/${k}`);
  }
  return keys.length;
}

/** Remove todos os objetos de um prefixo. */
export async function removePrefix(prefix: string): Promise<void> {
  const keys: string[] = [];
  for await (const o of minio.listObjectsV2(MINIO_BUCKET, prefix, true)) if (o.name) keys.push(o.name);
  if (keys.length) await minio.removeObjects(MINIO_BUCKET, keys);
}

/** Caminho lógico usado no motor ("media/x", "sim/x") → chave no bucket. null = caminho inválido. */
export function objectKeyFor(path: string, kitKey: string): string | null {
  if (!path || path.includes('..') || path.includes('\\')) return null;
  if (path.startsWith('sim/')) return path;
  if (path.startsWith('media/')) return `kits/${kitKey}/${path}`;
  return null;
}
