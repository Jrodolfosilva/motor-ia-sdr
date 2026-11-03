<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;

/**
 * One priced model in the AI catalog (see config/ai_models.php and
 * App\Services\Ai\AiModelCatalog). Global, not per tenant - prices are
 * the provider's list prices, and each tenant pays with their own key.
 */
#[Fillable([
    'provider',
    'model_id',
    'label',
    'capabilities',
    'input_per_mtok',
    'cached_input_per_mtok',
    'output_per_mtok',
    'per_audio_minute',
    'recommended_for',
    'is_active',
    'sort_order',
    'price_updated_at',
])]
class AiModel extends Model
{
    protected function casts(): array
    {
        return [
            'capabilities' => 'array',
            'recommended_for' => 'array',
            'input_per_mtok' => 'float',
            'cached_input_per_mtok' => 'float',
            'output_per_mtok' => 'float',
            'per_audio_minute' => 'float',
            'is_active' => 'boolean',
            'price_updated_at' => 'datetime',
        ];
    }

    /**
     * @param  Builder<AiModel>  $query
     */
    public function scopeActive(Builder $query): void
    {
        $query->where('is_active', true);
    }

    /**
     * The price fields copied onto every ai_usages row at call time.
     *
     * @return array{input: float|null, cached_input: float|null, output: float|null, per_audio_minute: float|null}
     */
    public function unitPrices(): array
    {
        return [
            'input' => $this->input_per_mtok,
            'cached_input' => $this->cached_input_per_mtok,
            'output' => $this->output_per_mtok,
            'per_audio_minute' => $this->per_audio_minute,
        ];
    }
}
