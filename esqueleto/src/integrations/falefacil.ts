// Canal Fale Fácil Chat (WhatsApp no Bitrix24). Doc: https://b24.falefacilchat.com.br/docs.php
// Um endpoint (api.php, ação no corpo), chave por conexão (X-Api-Key), 120 req/min.
// Conexão Meta Cloud API: texto livre só na janela de 24h; fora dela, template aprovado.
import type { InboundMessage } from './types';

const BASE = 'https://b24.falefacilchat.com.br/api.php';

export class FaleFacilError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export interface FaleFacil {
  status(): Promise<Record<string, unknown>>;
  sendText(to: string, message: string): Promise<string | null>;
  sendMedia(to: string, type: 'image' | 'video' | 'audio' | 'document', url: string, caption?: string | null): Promise<string | null>;
  sendTemplate(to: string, name: string, lang: string, bodyParams: string[], header?: { type: string; url: string } | null): Promise<string | null>;
  listTemplates(): Promise<unknown[]>;
  transferChat(to: string, id: string, type: 'user' | 'queue'): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function faleFacil(apiKey: string, fetchImpl: typeof fetch = fetch): FaleFacil {
  async function call(body: Record<string, unknown> | null, query = ''): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const r = await fetchImpl(`${BASE}${query}`, {
        method: body ? 'POST' : 'GET',
        headers: { 'X-Api-Key': apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
      // limite de requisições: respeita Retry-After (até 2 tentativas)
      if (r.status === 429 && attempt < 2) {
        await sleep(Math.min(30, Number(r.headers.get('retry-after')) || 5) * 1000);
        continue;
      }
      let json: any = null;
      try { json = await r.json(); } catch { /* corpo não-JSON */ }
      if (!r.ok || json?.success === false) throw new FaleFacilError(`Fale Fácil ${r.status}: ${json?.error ?? r.statusText}`, r.status);
      return json?.data ?? {};
    }
  }
  const id = (d: any) => (d?.message_id ? String(d.message_id) : null);
  return {
    status: () => call(null, '?action=status'),
    async sendText(to, message) {
      return id(await call({ action: 'send_text', to, message: message.slice(0, 4096) }));
    },
    async sendMedia(to, type, url, caption) {
      return id(await call({ action: 'send_media', to, type, url, ...(caption && type !== 'audio' ? { caption } : {}) }));
    },
    async sendTemplate(to, name, lang, bodyParams, header) {
      const components = bodyParams.length ? [{ type: 'body', parameters: bodyParams.map((text) => ({ type: 'text', text })) }] : [];
      return id(await call({
        action: 'send_template', to, template_name: name, template_lang: lang || 'pt_BR',
        ...(components.length ? { components_json: JSON.stringify(components) } : {}),
        ...(header?.url ? { header_media_url: header.url, header_media_type: header.type } : {}),
      }));
    },
    async listTemplates() {
      return (await call(null, '?action=list_templates')).templates ?? [];
    },
    async transferChat(to, transferId, type) {
      await call({ action: 'transfer_chat', to, transfer_id: transferId, transfer_type: type });
    },
  };
}

const MEDIA_TYPES = ['image', 'audio', 'video', 'document', 'sticker'] as const;

/** Primeira URL http(s) que aparecer no objeto da mídia (o Fale Fácil pode injetar o link). */
function findUrl(o: any, depth = 0): string | null {
  if (!o || typeof o !== 'object' || depth > 3) return null;
  for (const k of ['url', 'link', 'file_url', 'media_url', 'mediaUrl', 'URL', 'download_url']) {
    if (typeof o[k] === 'string' && /^https?:\/\//.test(o[k])) return o[k];
  }
  for (const v of Object.values(o)) {
    const u = findUrl(v, depth + 1);
    if (u) return u;
  }
  return null;
}

/** Link do arquivo que o Fale Fácil injeta na raiz do payload (`file_url`), fora do objeto da mídia. */
const rootFileUrl = (p: any): string | null =>
  typeof p?.file_url === 'string' && /^https?:\/\//.test(p.file_url) ? p.file_url : null;

/**
 * Payload do webhook → mensagem normalizada. Aceita o formato Meta ({ message, contact }), o formato
 * WAPI ({ event: { Info, Message } }) e o já normalizado do node n8n ({ from, text, messageType }).
 * null = não é mensagem (status, entrega, leitura…).
 */
export function normalizeWebhook(p: any): InboundMessage | null {
  if (!p || typeof p !== 'object') return null;

  // Meta Cloud API
  if (p.message && typeof p.message === 'object' && p.message.from) {
    const m = p.message;
    const t = String(m.type ?? 'text');
    const type = (t === 'text' ? 'text' : t === 'reaction' ? 'reaction' : (MEDIA_TYPES as readonly string[]).includes(t) ? t : t === 'button' || t === 'interactive' ? 'text' : 'other') as InboundMessage['type'];
    const media = (MEDIA_TYPES as readonly string[]).includes(t) ? m[t] ?? {} : null;
    const text = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? media?.caption ?? '';
    return {
      id: String(m.id ?? ''), from: String(m.from), name: p.contact?.profile?.name ?? null,
      fromMe: false, isGroup: false, type: type === 'sticker' ? 'sticker' : type, text: String(text),
      media: media ? { id: media.id ?? null, url: findUrl(media) ?? rootFileUrl(p) ?? findUrl(p.media) ?? null, mime: media.mime_type ?? null, filename: media.filename ?? null } : null,
    };
  }

  // WAPI (WhatsApp Web)
  if (p.event?.Info) {
    const info = p.event.Info;
    const msg = p.event.Message ?? {};
    const jid = String(info.Chat ?? info.Sender ?? '');
    const kinds: Record<string, InboundMessage['type']> = {
      imageMessage: 'image', audioMessage: 'audio', videoMessage: 'video', documentMessage: 'document', stickerMessage: 'sticker', reactionMessage: 'reaction',
    };
    const key = Object.keys(kinds).find((k) => msg[k]);
    const media = key ? msg[key] : null;
    return {
      id: String(info.ID ?? ''), from: jid.split('@')[0], name: info.PushName ?? null,
      fromMe: !!info.IsFromMe, isGroup: !!info.IsGroup || jid.endsWith('@g.us'),
      type: key ? kinds[key] : msg.conversation || msg.extendedTextMessage ? 'text' : 'other',
      text: String(msg.conversation ?? msg.extendedTextMessage?.text ?? media?.caption ?? ''),
      media: media ? { url: findUrl(media) ?? rootFileUrl(p), mime: media.mimetype ?? null, filename: media.fileName ?? null } : null,
    };
  }

  // formato normalizado (node do n8n / repasse)
  if (p.from && (p.messageType || p.text != null)) {
    const t = String(p.messageType ?? 'text');
    return {
      id: String(p.messageId ?? ''), from: String(p.from), name: p.fromName ?? null,
      fromMe: !!p.isFromMe, isGroup: !!p.isGroup,
      type: (['text', 'audio', 'image', 'document', 'video', 'sticker', 'reaction'].includes(t) ? t : 'other') as InboundMessage['type'],
      text: String(p.text ?? ''), media: p.mediaUrl ? { url: p.mediaUrl, mime: p.mimeType ?? null } : null,
    };
  }
  return null;
}
