// OpenAI / Together / DeepSeek: mesmo formato chat-completions.
import type { ChatMessage, LlmProvider, LlmResult, ToolDef } from '../engine/types';

const ENDPOINTS = {
  openai: 'https://api.openai.com/v1/chat/completions',
  together: 'https://api.together.xyz/v1/chat/completions',
  deepseek: 'https://api.deepseek.com/chat/completions',
} as const;

const TIMEOUT_MS = 20_000;
const RETRIES = 2;

function toOpenAiContent(c: ChatMessage['content']) {
  if (typeof c === 'string') return c;
  return c.map((p) => (p.type === 'text'
    ? { type: 'text', text: p.text }
    : { type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.data}` } }));
}

async function postWithRetry(url: string, apiKey: string, body: unknown, timeoutMs = TIMEOUT_MS): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return res.json();
      const retriable = res.status === 429 || res.status >= 500;
      lastErr = new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
      if (!retriable) throw lastErr;
    } catch (e) {
      lastErr = e;
      const isHttpNonRetriable = e instanceof Error && /^HTTP (4\d\d)/.test(e.message) && !e.message.startsWith('HTTP 429');
      if (isHttpNonRetriable) throw e;
    }
    if (attempt < RETRIES) await new Promise((r) => setTimeout(r, 1000));
  }
  throw lastErr;
}

export function openAiCompatible(provider: keyof typeof ENDPOINTS): LlmProvider {
  return {
    async chat({ apiKey, model, messages, system, tools = [], temperature, timeoutMs }): Promise<LlmResult> {
      const payload: Record<string, unknown> = {
        model,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          ...messages.map((m) => ({ role: m.role, content: toOpenAiContent(m.content) })),
        ],
      };
      if (temperature !== undefined) payload.temperature = temperature;
      if (tools.length) {
        payload.tools = tools.map((t: ToolDef) => ({ type: 'function', function: t }));
      }

      const raw = await postWithRetry(ENDPOINTS[provider], apiKey, payload, timeoutMs);
      const msg = raw?.choices?.[0]?.message ?? {};
      const toolCalls = (msg.tool_calls ?? []).map((c: any) => {
        let args = {};
        try { args = JSON.parse(c.function?.arguments ?? '{}') ?? {}; } catch { /* {} */ }
        return { name: c.function?.name, arguments: args };
      });
      return { text: msg.content ?? '', toolCalls, raw };
    },
  };
}
