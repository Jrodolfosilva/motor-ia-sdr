// CRM Bitrix24 via webhook de entrada (https://<portal>/rest/<user>/<código>/<método>.json).
// O webhook é criado por um admin do portal (Aplicativos → Webhooks → Webhook de entrada) com
// permissão de CRM, Usuários e Canais Abertos.
import { phoneVariants } from './phone';

export class BitrixError extends Error {}

export interface BitrixStage { id: string; name: string; sort: number; semantics: string | null }
export interface BitrixUser { id: string; name: string; active: boolean }
export interface BitrixField { code: string; label: string; type: string; items?: { id: string; value: string }[] }
export interface BitrixQueue { id: string; name: string }
export interface BitrixCatalog {
  portal: string;
  stages: BitrixStage[];
  users: BitrixUser[];
  fields: BitrixField[];
  queues: BitrixQueue[];
  /** Avisos (ex: webhook sem permissão de Canais Abertos). */
  warnings: string[];
}

export interface Bitrix {
  portal: string;
  call<T = any>(method: string, params?: Record<string, unknown>): Promise<T>;
  catalog(): Promise<BitrixCatalog>;
  fields(): Promise<BitrixField[]>;
  getLead(id: string | number): Promise<Record<string, any> | null>;
  findLeadByPhone(phone: string): Promise<string | null>;
  updateLead(id: string | number, fields: Record<string, unknown>): Promise<void>;
  comment(leadId: string | number, text: string): Promise<void>;
  /** A automação do Fale Fácil (robô) já mandou WhatsApp para este lead? */
  sentByAutomation(leadId: string | number): Promise<boolean>;
  /** Leads criados a partir de `since` (mais novos primeiro, até `max`). */
  recentLeads(since: Date, max?: number): Promise<Record<string, any>[]>;
}

/** Normaliza o endereço colado no painel (aceita com ou sem método no fim). */
export function normalizeWebhookUrl(url: string): string {
  const u = url.trim().replace(/\/[a-z0-9_.]+\.json$/i, '/').replace(/\/?$/, '/');
  if (!/^https:\/\/[^/]+\/rest\/\d+\/[^/]+\/$/.test(u)) {
    throw new BitrixError('Endereço do webhook inválido. Formato: https://<portal>.bitrix24.com.br/rest/<id>/<código>/');
  }
  return u;
}

const FIELD_CACHE_MS = 10 * 60 * 1000;

export function bitrix(webhookUrl: string, fetchImpl: typeof fetch = fetch): Bitrix {
  const base = normalizeWebhookUrl(webhookUrl);
  const portal = new URL(base).origin;
  let fieldsCache: { at: number; list: BitrixField[] } | null = null;

  async function call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const r = await fetchImpl(`${base}${method}.json`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params), signal: AbortSignal.timeout(30_000),
    });
    let json: any = null;
    try { json = await r.json(); } catch { /* corpo não-JSON */ }
    if (!r.ok || json?.error) throw new BitrixError(`Bitrix ${method}: ${json?.error_description || json?.error || r.statusText}`);
    return json as T;
  }

  /** Lista paginada (50 por página). */
  async function all<T>(method: string, params: Record<string, unknown> = {}, max = 1000): Promise<T[]> {
    const out: T[] = [];
    let start: number | undefined = 0;
    while (start != null && out.length < max) {
      const r: any = await call(method, { ...params, start });
      out.push(...(r.result ?? []));
      start = r.next;
    }
    return out;
  }

  async function fields(): Promise<BitrixField[]> {
    if (fieldsCache && Date.now() - fieldsCache.at < FIELD_CACHE_MS) return fieldsCache.list;
    const r: any = await call('crm.lead.fields');
    const list = Object.entries<any>(r.result ?? {})
      .filter(([, v]) => !v.isReadOnly)
      .map(([code, v]) => ({
        code,
        label: String(v.formLabel || v.listLabel || v.title || code),
        type: String(v.type),
        ...(Array.isArray(v.items) ? { items: v.items.map((i: any) => ({ id: String(i.ID), value: String(i.VALUE) })) } : {}),
      }));
    fieldsCache = { at: Date.now(), list };
    return list;
  }

  return {
    portal,
    call,
    fields,
    async catalog() {
      const warnings: string[] = [];
      const stages = ((await call('crm.status.list', { filter: { ENTITY_ID: 'STATUS' }, order: { SORT: 'ASC' } })).result ?? []).map((s: any) => ({
        id: String(s.STATUS_ID), name: String(s.NAME), sort: Number(s.SORT), semantics: s.SEMANTICS ?? null,
      }));
      let users: BitrixUser[] = [];
      try {
        users = (await all<any>('user.get', { FILTER: { ACTIVE: true, USER_TYPE: 'employee' } })).map((u) => ({
          id: String(u.ID), name: [u.NAME, u.LAST_NAME].filter(Boolean).join(' ') || u.EMAIL || `#${u.ID}`, active: u.ACTIVE !== false,
        })).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
      } catch (e) { warnings.push(`Usuários: ${(e as Error).message} (dê permissão "Usuários" ao webhook).`); }
      let queues: BitrixQueue[] = [];
      try {
        const r: any = await call('imopenlines.config.list.get');
        queues = (r.result ?? []).map((c: any) => ({ id: String(c.ID), name: String(c.LINE_NAME ?? `Canal ${c.ID}`) }));
      } catch (e) { warnings.push(`Canais Abertos: ${(e as Error).message} (dê permissão "Canais Abertos" ao webhook para transferir por fila).`); }
      return { portal, stages, users, fields: await fields(), queues, warnings };
    },
    async getLead(id) {
      try { return (await call('crm.lead.get', { id })).result ?? null; } catch (e) {
        if (/not found/i.test((e as Error).message)) return null;
        throw e;
      }
    },
    async findLeadByPhone(phone) {
      const values = phoneVariants(phone);
      if (!values.length) return null;
      const r: any = await call('crm.duplicate.findbycomm', { entity_type: 'LEAD', type: 'PHONE', values });
      const ids: number[] = (r.result?.LEAD ?? []).map(Number).filter(Boolean);
      return ids.length ? String(Math.max(...ids)) : null; // o mais recente
    },
    async updateLead(id, f) {
      await call('crm.lead.update', { id, fields: f, params: { REGISTER_SONET_EVENT: 'N' } });
    },
    async comment(leadId, text) {
      await call('crm.timeline.comment.add', { fields: { ENTITY_ID: Number(leadId), ENTITY_TYPE: 'lead', COMMENT: text.slice(0, 8000) } });
    },
    async sentByAutomation(leadId) {
      const r: any = await call('crm.activity.list', {
        filter: { OWNER_TYPE_ID: 1, OWNER_ID: leadId, PROVIDER_ID: 'CONFIGURABLE_REST_APP' }, select: ['ID', 'SUBJECT'],
      });
      return (r.result ?? []).some((a: any) => /whats/i.test(String(a.SUBJECT ?? '')));
    },
    async recentLeads(since, max = 500) {
      return all('crm.lead.list', {
        filter: { '>=DATE_CREATE': since.toISOString().replace(/\.\d{3}Z$/, '+00:00') }, order: { DATE_CREATE: 'DESC' },
        select: ['ID', 'TITLE', 'NAME', 'LAST_NAME', 'STATUS_ID', 'SOURCE_ID', 'DATE_CREATE', 'PHONE'],
      }, max);
    },
  };
}

// ---------- Campos do lead ↔ dados do atendimento ----------

/** Valor de um campo do lead como texto (lista → rótulo, telefone → número, "estou_desempregada!" → "estou desempregada!"). */
export function leadValue(lead: Record<string, any>, code: string, field?: BitrixField): string {
  const v = lead[code];
  if (v == null || v === '' || v === false) return '';
  if (Array.isArray(v)) {
    return v.map((x) => (x && typeof x === 'object' ? x.VALUE ?? '' : field?.items?.find((i) => i.id === String(x))?.value ?? x)).filter(Boolean).join(', ');
  }
  if (field?.items) return field.items.find((i) => i.id === String(v))?.value ?? String(v);
  if (field?.type === 'date' || field?.type === 'datetime') {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
    if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  }
  // respostas de formulário do Bitrix chegam como "sim,_já_fiz_..." (espaço virou _)
  return String(v).replace(/_/g, ' ').trim();
}

/** Valor coletado → formato do campo no Bitrix. null = não dá para gravar (ex: data vaga). */
export function toBitrixValue(value: unknown, field?: BitrixField): unknown {
  const s = String(value ?? '').trim();
  if (!s) return null;
  if (field?.type === 'date' || field?.type === 'datetime') {
    const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
    return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
  }
  if (field?.items) {
    const hit = field.items.find((i) => i.value.toLowerCase() === s.toLowerCase());
    return hit ? hit.id : null;
  }
  if (field?.type === 'double' || field?.type === 'integer') {
    const n = Number(s.replace(',', '.').replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  if (field?.type === 'boolean') return /^(s|sim|y|yes|true|1)/i.test(s) ? 'Y' : 'N';
  return s;
}
