<?php

namespace App\Services\Ai;

use App\Models\AiModel;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Http;

/**
 * Read/write access to the `ai_models` price catalog - the one place the
 * wizard's model selects, the per-role defaults and every ai_usages price
 * snapshot come from.
 */
class AiModelCatalog
{
    protected const TOGETHER_MODELS_URL = 'https://api.together.xyz/v1/models';

    protected const TIMEOUT_SECONDS = 30;

    /**
     * In-memory lookup cache for the current request/job - a single
     * onboarding turn prices up to 3 calls against the same model.
     *
     * @var array<string, AiModel|null>
     */
    private array $resolved = [];

    /**
     * Upserts every entry of config('ai_models.catalog') into the table.
     * Prices from config win over whatever is stored - config is the
     * reviewed source of truth; `syncTogether()` is the live refresh.
     *
     * @return int Number of catalog entries synced.
     */
    public function syncFromConfig(): int
    {
        $entries = config('ai_models.catalog', []);

        foreach ($entries as $index => $entry) {
            $model = AiModel::firstOrNew([
                'provider' => $entry['provider'],
                'model_id' => $entry['model_id'],
            ]);

            $prices = [
                'input_per_mtok' => $entry['input'] ?? null,
                'cached_input_per_mtok' => $entry['cached_input'] ?? null,
                'output_per_mtok' => $entry['output'] ?? null,
                'per_audio_minute' => $entry['per_audio_minute'] ?? null,
            ];

            $pricesChanged = ! $model->exists || collect($prices)->contains(
                fn ($value, $column) => (float) $model->{$column} !== (float) $value
            );

            $model->fill($prices + [
                'label' => $entry['label'],
                'capabilities' => $entry['capabilities'] ?? ['chat'],
                'recommended_for' => $entry['recommended_for'] ?? [],
                'is_active' => true,
                'sort_order' => $index,
            ]);

            if ($pricesChanged) {
                $model->price_updated_at = now();
            }

            $model->save();
        }

        $this->resolved = [];

        return count($entries);
    }

    /**
     * Refreshes Together prices from its live /models endpoint. Existing
     * rows get their prices updated; chat models Together offers that the
     * catalog doesn't know yet are added *inactive*, so an admin decides
     * what shows up in the wizard instead of every new release appearing
     * there automatically.
     *
     * @return array{updated: int, added: int}
     */
    public function syncTogether(string $apiKey): array
    {
        $response = Http::withToken($apiKey)
            ->timeout(self::TIMEOUT_SECONDS)
            ->get(self::TOGETHER_MODELS_URL)
            ->throw()
            ->json();

        $remoteModels = array_is_list($response ?? []) ? $response : ($response['data'] ?? []);
        $updated = 0;
        $added = 0;

        foreach ($remoteModels as $remote) {
            $modelId = $remote['id'] ?? null;
            $pricing = $remote['pricing'] ?? null;
            if (! $modelId || ! is_array($pricing) || ! in_array($remote['type'] ?? 'chat', ['chat', 'language'], true)) {
                continue;
            }

            $model = AiModel::firstOrNew(['provider' => 'together', 'model_id' => $modelId]);

            if (! $model->exists) {
                $model->fill([
                    'label' => $remote['display_name'] ?? $modelId,
                    'capabilities' => ['chat'],
                    'recommended_for' => [],
                    'is_active' => false,
                    'sort_order' => 1000,
                ]);
                $added++;
            } else {
                $updated++;
            }

            // Together reports prices in USD per 1M tokens, same unit the
            // catalog stores.
            // Rounded: the API reports float noise like 0.12999999999999998.
            $model->input_per_mtok = round((float) ($pricing['input'] ?? 0), 6);
            $model->output_per_mtok = round((float) ($pricing['output'] ?? 0), 6);
            if (isset($pricing['cached_input'])) {
                $model->cached_input_per_mtok = round((float) $pricing['cached_input'], 6);
            }
            if ($model->isDirty(['input_per_mtok', 'output_per_mtok', 'cached_input_per_mtok'])) {
                $model->price_updated_at = now();
            }

            $model->save();
        }

        $this->resolved = [];

        return ['updated' => $updated, 'added' => $added];
    }

    public function find(string $provider, string $modelId): ?AiModel
    {
        $key = "{$provider}|{$modelId}";

        if (! array_key_exists($key, $this->resolved)) {
            $this->resolved[$key] = AiModel::where('provider', $provider)->where('model_id', $modelId)->first();
        }

        return $this->resolved[$key];
    }

    /**
     * Active chat models for one provider, in catalog order - the
     * wizard's model select options.
     *
     * @return array<int, array{value: string, label: string, vision: bool}>
     */
    public function optionsFor(string $provider): array
    {
        return $this->chatModels($provider)
            ->map(fn (AiModel $model) => [
                'value' => $model->model_id,
                'label' => $model->label,
                'vision' => self::supportsVision($model),
            ])
            ->values()
            ->all();
    }

    /**
     * The provider's default model for each onboarding role (see
     * config('ai_models.roles')) - what the wizard pre-selects so a tenant
     * only has to paste an API key. A role nobody marked as recommended
     * falls back to the provider's first active chat model - except
     * `vision`, which only ever gets a vision-capable model (none = the
     * role is left out and media goes to a human).
     *
     * @return array<string, string>
     */
    public function recommendedFor(string $provider): array
    {
        $models = $this->chatModels($provider);
        $fallback = $models->first()?->model_id;

        return collect(array_keys(config('ai_models.roles', [])))
            ->mapWithKeys(function (string $role) use ($models, $fallback) {
                $recommended = $models->first(fn (AiModel $model) => in_array($role, $model->recommended_for ?? [], true)
                    && ($role !== 'vision' || self::supportsVision($model)));

                return [$role => $recommended?->model_id ?? ($role === 'vision' ? null : $fallback)];
            })
            ->filter()
            ->all();
    }

    public static function supportsVision(AiModel $model): bool
    {
        return in_array('vision', $model->capabilities ?? [], true);
    }

    /**
     * @return Collection<int, AiModel>
     */
    private function chatModels(string $provider)
    {
        return AiModel::active()
            ->where('provider', $provider)
            ->orderBy('sort_order')
            ->orderBy('id')
            ->get()
            ->filter(fn (AiModel $model) => in_array('chat', $model->capabilities ?? [], true))
            ->values();
    }
}
