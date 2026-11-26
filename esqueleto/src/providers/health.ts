// Ping da IA: chamada mínima (poucos tokens) em cada modelo do agente para saber se a chave vale,
// se tem crédito e se o modelo responde. A Together não expõe saldo pela API: o erro da chamada é o sinal.

const TOGETHER_CHAT = 'https://api.together.xyz/v1/chat/completions';
const TIMEOUT_MS = 30_000;

export type AiHealthStatus = 'ok' | 'no_key' | 'invalid_key' | 'no_credit' | 'rate_limited' | 'model_not_found' | 'timeout' | 'error';

export interface AiModelHealth {
  model: string;
  roles: string[];
  status: AiHealthStatus;
  ok: boolean;
  ms: number;
  detail: string;
}

const LABEL: Record<AiHealthStatus, string> = {
  ok: 'Funcionando',
  no_key: 'Chave da IA não configurada (TOGETHER_API_KEY)',
  invalid_key: 'Chave da IA inválida ou revogada',
  no_credit: 'Sem crédito na conta da IA',
  rate_limited: 'Limite de uso atingido (muitas chamadas)',
  model_not_found: 'Modelo não encontrado / indisponível',
  timeout: 'IA não respondeu a tempo',
  error: 'Erro na IA',
};

export function classify(status: number, body: string): AiHealthStatus {
  const b = body.toLowerCase();
  if (status === 402 || /credit|balance|insufficient|quota|payment|billing/.test(b)) return 'no_credit';
  if (status === 401 || status === 403 || /invalid api key|unauthorized|authentication/.test(b)) return 'invalid_key';
  if (status === 404 || /model.*(not found|does not exist|unavailable)|unable to access model/.test(b)) return 'model_not_found';
  if (status === 429) return 'rate_limited';
  return 'error';
}

export async function pingModel(apiKey: string, model: string, roles: string[], fetchImpl: typeof fetch = fetch): Promise<AiModelHealth> {
  const t0 = Date.now();
  const out = (status: AiHealthStatus, detail = ''): AiModelHealth => ({
    model, roles, status, ok: status === 'ok', ms: Date.now() - t0, detail: detail ? `${LABEL[status]}: ${detail}` : LABEL[status],
  });
  if (!apiKey) return out('no_key');
  try {
    const r = await fetchImpl(TOGETHER_CHAT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 5, temperature: 0 }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (r.ok) return out('ok');
    const body = (await r.text()).slice(0, 300);
    return out(classify(r.status, body), `HTTP ${r.status} ${body}`);
  } catch (e) {
    const err = e as Error;
    if (err.name === 'TimeoutError' || /timeout/i.test(err.message)) return out('timeout');
    return out('error', err.message.slice(0, 200));
  }
}

/** Testa cada modelo distinto usado pelo agente (responder, extractor, qualifier, vision). */
export async function aiHealth(apiKey: string, models: Record<string, string>): Promise<{ ok: boolean; checkedAt: string; models: AiModelHealth[] }> {
  const byModel = new Map<string, string[]>();
  for (const [role, model] of Object.entries(models)) if (model) byModel.set(model, [...(byModel.get(model) ?? []), role]);
  const results = await Promise.all([...byModel].map(([m, roles]) => pingModel(apiKey, m, roles)));
  return { ok: results.length > 0 && results.every((r) => r.ok), checkedAt: new Date().toISOString(), models: results };
}
