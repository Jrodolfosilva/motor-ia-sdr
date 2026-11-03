<?php

namespace App\Services\Ai;

use App\Models\AiAgent;
use App\Models\AiUsage;
use Illuminate\Support\Facades\Log;

/**
 * Writes one ai_usages row per billed AI call, pricing it right away from
 * the ai_models catalog. Never throws - a pricing/bookkeeping failure must
 * not take down the lead-facing turn it is accounting for.
 */
class AiUsageRecorder
{
    public function __construct(private AiModelCatalog $catalog) {}

    /**
     * @param  array<string, mixed>|null  $rawResponse  The provider's raw API response (carries `usage`).
     */
    public function recordChat(AiAgent $agent, ?int $contactId, string $step, string $modelId, ?array $rawResponse, ?int $logId = null): ?AiUsage
    {
        $provider = $agent->provider?->value ?? (string) $agent->provider;
        $tokens = self::normalizeUsage($provider, $rawResponse['usage'] ?? null);

        return $this->write($agent, $contactId, $logId, $step, $provider, $modelId, $tokens, null);
    }

    public function recordTranscription(AiAgent $agent, ?int $contactId, string $provider, string $modelId, float $audioSeconds, ?int $logId = null): ?AiUsage
    {
        return $this->write($agent, $contactId, $logId, 'transcription', $provider, $modelId, ['input' => 0, 'cached' => 0, 'output' => 0], $audioSeconds);
    }

    /**
     * Maps each provider's usage object onto one shape. `input` here is
     * always the *uncached* input count, so cost is a plain sum:
     * - Anthropic: input_tokens already excludes cache reads (reported in
     *   cache_read_input_tokens); cache writes are billed as input.
     * - OpenAI-compatible (OpenAI, Together): prompt_tokens includes the
     *   cached part (prompt_tokens_details.cached_tokens).
     * - DeepSeek: prompt_tokens includes prompt_cache_hit_tokens.
     *
     * @param  array<string, mixed>|null  $usage
     * @return array{input: int, cached: int, output: int}
     */
    public static function normalizeUsage(string $provider, ?array $usage): array
    {
        if (! is_array($usage)) {
            return ['input' => 0, 'cached' => 0, 'output' => 0];
        }

        if ($provider === 'anthropic') {
            return [
                'input' => (int) ($usage['input_tokens'] ?? 0) + (int) ($usage['cache_creation_input_tokens'] ?? 0),
                'cached' => (int) ($usage['cache_read_input_tokens'] ?? 0),
                'output' => (int) ($usage['output_tokens'] ?? 0),
            ];
        }

        $prompt = (int) ($usage['prompt_tokens'] ?? 0);
        $cached = (int) ($usage['prompt_tokens_details']['cached_tokens']
            ?? $usage['prompt_cache_hit_tokens']
            ?? $usage['cached_tokens']
            ?? 0);
        $cached = min($cached, $prompt);

        return [
            'input' => $prompt - $cached,
            'cached' => $cached,
            'output' => (int) ($usage['completion_tokens'] ?? 0),
        ];
    }

    /**
     * Cached tokens with no cached price fall back to the full input price
     * - never under-reports spend.
     *
     * @param  array{input: int, cached: int, output: int}  $tokens
     * @param  array{input: float|null, cached_input: float|null, output: float|null, per_audio_minute: float|null}  $prices
     */
    public static function cost(array $tokens, array $prices, ?float $audioSeconds = null): float
    {
        $cachedRate = $prices['cached_input'] ?? $prices['input'] ?? 0.0;

        $cost = ($tokens['input'] / 1_000_000 * ($prices['input'] ?? 0.0))
            + ($tokens['cached'] / 1_000_000 * $cachedRate)
            + ($tokens['output'] / 1_000_000 * ($prices['output'] ?? 0.0));

        if ($audioSeconds !== null) {
            $cost += $audioSeconds / 60 * ($prices['per_audio_minute'] ?? 0.0);
        }

        return $cost;
    }

    /**
     * @param  array{input: int, cached: int, output: int}  $tokens
     */
    private function write(AiAgent $agent, ?int $contactId, ?int $logId, string $step, string $provider, string $modelId, array $tokens, ?float $audioSeconds): ?AiUsage
    {
        try {
            $model = $this->catalog->find($provider, $modelId);
            $prices = $model?->unitPrices() ?? ['input' => null, 'cached_input' => null, 'output' => null, 'per_audio_minute' => null];

            if ($model === null) {
                Log::warning('AI usage recorded for a model missing from the ai_models catalog - cost stored as 0', [
                    'provider' => $provider,
                    'model_id' => $modelId,
                ]);
            }

            return AiUsage::create([
                'tenant_id' => $agent->tenant_id,
                'ai_agent_id' => $agent->id,
                'contact_id' => $contactId,
                'ai_agent_log_id' => $logId,
                'step' => $step,
                'provider' => $provider,
                'model_id' => $modelId,
                'input_tokens' => $tokens['input'],
                'cached_input_tokens' => $tokens['cached'],
                'output_tokens' => $tokens['output'],
                'audio_seconds' => $audioSeconds,
                'unit_prices' => $prices,
                'cost_usd' => self::cost($tokens, $prices, $audioSeconds),
            ]);
        } catch (\Throwable $e) {
            Log::error('Failed to record AI usage', [
                'agent_id' => $agent->id,
                'step' => $step,
                'error' => $e->getMessage(),
            ]);

            return null;
        }
    }
}
