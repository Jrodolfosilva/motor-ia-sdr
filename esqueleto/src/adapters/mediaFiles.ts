// Acesso a arquivos de mídia + PDF (texto e render de página) para o MediaAnalyzer.
// Fase 1: disco local. Fase 2: trocar `read` por storage (S3/GridFS) sem mexer no motor.
import { existsSync, readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import type { MediaFiles } from '../engine/agents/mediaAnalyzer';

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.pdf': 'application/pdf',
};

export const mimeForPath = (p: string) => MIME_BY_EXT[extname(p).toLowerCase()] ?? 'application/octet-stream';

/** `roots` mapeia prefixo do caminho ("sim/") para a pasta real. Bloqueia sair da pasta. */
export function localMediaFiles(roots: Record<string, string>): MediaFiles {
  return {
    async read(path) {
      const prefix = Object.keys(roots).find((p) => path.startsWith(p));
      if (!prefix) return null;
      const dir = resolve(roots[prefix]);
      const full = resolve(dir, path.slice(prefix.length));
      if (!full.startsWith(dir + sep) || !existsSync(full)) return null;
      return { data: readFileSync(full), mime: mimeForPath(full) };
    },

    async pdfText(data, maxPages) {
      const { getDocumentProxy } = await import('unpdf');
      const doc = await getDocumentProxy(new Uint8Array(data));
      const n = Math.min(maxPages, doc.numPages);
      const out: string[] = [];
      for (let i = 1; i <= n; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        out.push(content.items.map((it: any) => ('str' in it ? it.str : '')).join(' '));
      }
      return out.join('\n');
    },

    async pdfPagesAsPng(data, maxPages) {
      const { getDocumentProxy, renderPageAsImage } = await import('unpdf');
      const doc = await getDocumentProxy(new Uint8Array(data));
      const n = Math.min(maxPages, doc.numPages);
      const pages: Buffer[] = [];
      for (let i = 1; i <= n; i++) {
        const png = await renderPageAsImage(new Uint8Array(data), i, { canvas: () => import('@napi-rs/canvas'), scale: 2 });
        pages.push(Buffer.from(png));
      }
      return pages;
    },
  };
}
