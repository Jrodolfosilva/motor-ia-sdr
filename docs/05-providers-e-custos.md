# 05. Providers, modelos e custo

## Contrato
```ts
interface LlmProvider {
  chat(args: {
    apiKey: string; model: string;
    messages: { role: 'user' | 'assistant'; content: string | ContentPart[] }[];
    system?: string;
    tools?: { name: string; description: string; parameters: JSONSchema }[];
    temperature?: number;
  }): Promise<{ text: string; toolCalls: { name: string; arguments: Record<string, any> }[]; raw: any }>;

  vision(args: { apiKey; model; prompt: string; images: { mime: string; data: string /*base64*/ }[];
                 system?: string; temperature?: number }): Promise<same>;
}
```
Uma resposta pode ter **texto + várias tool calls ao mesmo tempo** (ex.: responder manda texto e chama `enviar_midia`; extractor chama `salvar_dado_lead` N vezes).

## OpenAI-compatible (OpenAI, Together, DeepSeek)
- Endpoint: OpenAI `https://api.openai.com/v1/chat/completions`, Together `https://api.together.xyz/v1/chat/completions`, DeepSeek `https://api.deepseek.com/chat/completions`.
- System vai como 1ª mensagem `{role:'system'}`.
- Tools: `{type:'function', function:{name, description, parameters}}`.
- Resposta: `choices[0].message.content` + `tool_calls[].function.{name, arguments(JSON string → parse, fallback {})}`.
- Visão: content `[{type:'text',text}, {type:'image_url', image_url:{url:'data:{mime};base64,{data}'}}]`.
- **Timeout 20s, retry 2x com 1s** em timeout/conexão, 429 e 5xx. (No bench, 1 timeout a cada 40 chamadas no Together; sem retry o lead recebia fallback.)
- Dica Node: dá pra usar o SDK `openai` com `baseURL` trocado para Together/DeepSeek.

## Anthropic
- `POST https://api.anthropic.com/v1/messages`, headers `x-api-key`, `anthropic-version`.
- `max_tokens: 1024`.
- System como bloco com `cache_control: {type:'ephemeral'}` (prompt grande e estável, cache barateia).
- Tools: `{name, description, input_schema}`.
- Resposta: blocos `text` concatenados + `tool_use` → `{name, arguments: input}`.
- Visão: `[{type:'image', source:{type:'base64', media_type, data}}, ..., {type:'text', text}]` (imagens antes do texto).
- Use o SDK `@anthropic-ai/sdk`.

## Transcrição de áudio
Groq Whisper `whisper-large-v3-turbo` (endpoint OpenAI-compat `/audio/transcriptions`). Retorna `{text, duration_seconds}`. Custo US$ 0.04 por minuto. Key é da plataforma (config), não do cliente.

## Catálogo de modelos (defaults por papel)
| Provider | responder | extractor / qualifier | vision |
|---|---|---|---|
| **together** (default recomendado) | `deepseek-ai/DeepSeek-V4-Pro-0813` | `deepseek-ai/DeepSeek-V4.1-Flash` | `nvidia/NVIDIA-Nemotron-3.5-Super-VL` |
| anthropic | `claude-sonnet-5` | `claude-haiku-4-5` | `claude-haiku-4-5` |
| openai | `gpt-4o` | `gpt-4o-mini` | `gpt-4o-mini` |
| deepseek | `deepseek-chat` | `deepseek-chat` | (sem visão: mídia → handoff) |

Preços (USD / 1M tokens: input · cached · output) e lista completa em `referencia-laravel/config/ai_models.php`. O comando `ai:sync-models --remote=together` puxava preços do `/models` do Together (rodava diariamente).

Benchmark real (20 conversas anonimizadas BellaPrev): Flash 97% de acerto a US$ 0.003 vs Pro 93%. Custo medido ponta a ponta: **~US$ 0.03–0.05 por lead qualificado**.

## Registro de uso/custo (`ai_usages`)
Uma linha por chamada LLM (sempre, independente de `log_executions`):
`agent_id, contact_id?, step (extractor|qualifier|responder|vision|transcription|test), provider, model, input_tokens, cached_tokens, output_tokens, audio_seconds?, price_input, price_cached, price_output, price_audio (snapshot!), cost_usd, log_id?, created_at`

**Normalização de usage** (input = SEM o cacheado):
- Anthropic: `input = input_tokens + cache_creation_input_tokens`, `cached = cache_read_input_tokens`, `output = output_tokens`
- OpenAI-compat: `prompt = prompt_tokens`, `cached = min(prompt_tokens_details.cached_tokens ?? prompt_cache_hit_tokens ?? cached_tokens ?? 0, prompt)`, `input = prompt - cached`, `output = completion_tokens`

**Custo:** `input/1e6*price.input + cached/1e6*(price.cached ?? price.input) + output/1e6*price.output (+ audioSec/60*price.per_audio_minute)`.

Snapshot do preço na linha: o relatório histórico não muda quando o catálogo atualiza.

## Log de execução (`ai_agent_logs`), opcional por agente
`agent_id, contact_id, step, system_prompt, user_message (última msg do user), raw_response, created_at`. É o que permite debugar "por que a IA respondeu isso". **No simulador, mostre isso num painel lateral** (prompt compilado + resposta crua por step).
