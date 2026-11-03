// Custo das chamadas: preços oficiais do Together (GET /v1/models, US$ por 1M tokens)
// + câmbio USD→BRL (AwesomeAPI). Tudo em cache; se a consulta falhar, usa o último valor
// conhecido ou o fallback (env USD_BRL).

export interface ModelPrice {
  /** US$ por 1M tokens de entrada / saída / entrada em cache. */
  input: number;
  output: number;
  cached_input: number;
  /** US$ por minuto de áudio (transcrição). */
  per_minute: number;
}

export interface Usage { input: number; output: number; cached: number }

const PRICES_TTL_MS = 6 * 60 * 60 * 1000;
const FX_TTL_MS = 60 * 60 * 1000;
const FX_FALLBACK = Number(process.env.USD_BRL ?? 5.5);

let prices: { at: number; byModel: Map<string, ModelPrice>; error?: string } = { at: 0, byModel: new Map() };
let fx: { at: number; rate: number; source: string; quotedAt: string | null } = {
  at: 0, rate: FX_FALLBACK, source: 'fallback (USD_BRL)', quotedAt: null,
};

export async function refreshPrices(apiKey: string): Promise<void> {
  if (!apiKey || Date.now() - prices.at < PRICES_TTL_MS) return;
  try {
    const r = await fetch('https://api.together.xyz/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const list: any[] = Array.isArray(j) ? j : j.data ?? [];
    const byModel = new Map<string, ModelPrice>();
    for (const m of list) {
      const p = m.pricing ?? {};
      byModel.set(m.id, {
        input: Number(p.input) || 0,
        output: Number(p.output) || 0,
        cached_input: Number(p.cached_input) || Number(p.input) || 0,
        per_minute: Number(p.transcribe?.price_per_minute) || 0,
      });
    }
    prices = { at: Date.now(), byModel };
  } catch (e) {
    prices = { ...prices, at: Date.now() - PRICES_TTL_MS + 60_000, error: (e as Error).message }; // tenta de novo em 1 min
  }
}

export async function refreshFx(): Promise<void> {
  if (Date.now() - fx.at < FX_TTL_MS) return;
  try {
    const r = await fetch('https://economia.awesomeapi.com.br/json/last/USD-BRL', { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const q = (await r.json()).USDBRL;
    const rate = Number(q?.bid);
    if (!rate) throw new Error('sem cotação');
    fx = { at: Date.now(), rate, source: 'AwesomeAPI (USD-BRL, compra)', quotedAt: q.create_date ?? null };
  } catch {
    fx = { ...fx, at: Date.now() - FX_TTL_MS + 60_000 };
  }
}

export const priceFor = (model: string) => prices.byModel.get(model) ?? null;
export const fxInfo = () => ({ rate: fx.rate, source: fx.source, quotedAt: fx.quotedAt });
export const pricesInfo = () => ({ loadedAt: prices.at ? new Date(prices.at).toISOString() : null, error: prices.error ?? null });

/** Tokens do campo `usage` no formato OpenAI/Together. */
export function usageFromRaw(raw: any): Usage | null {
  const u = raw?.usage;
  if (!u) return null;
  const cached = Number(u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens ?? 0) || 0;
  return { input: Number(u.prompt_tokens) || 0, output: Number(u.completion_tokens) || 0, cached };
}

export function tokensCostUsd(model: string, u: Usage): number | null {
  const p = priceFor(model);
  if (!p) return null;
  const fresh = Math.max(0, u.input - u.cached);
  return (fresh * p.input + u.cached * p.cached_input + u.output * p.output) / 1_000_000;
}

export function audioCostUsd(model: string, seconds: number): number | null {
  const p = priceFor(model);
  return p ? (seconds / 60) * p.per_minute : null;
}
