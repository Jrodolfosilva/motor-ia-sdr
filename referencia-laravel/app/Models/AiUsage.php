<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * One billed AI call (chat completion or transcription), written on every
 * call regardless of AiAgent::log_executions - the source for "quanto cada
 * cliente está gastando". Cost is computed once, at write time, from the
 * unit_prices snapshot (see App\Services\Ai\AiUsageRecorder).
 */
#[Fillable([
    'tenant_id',
    'ai_agent_id',
    'contact_id',
    'ai_agent_log_id',
    'step',
    'provider',
    'model_id',
    'input_tokens',
    'cached_input_tokens',
    'output_tokens',
    'audio_seconds',
    'unit_prices',
    'cost_usd',
])]
class AiUsage extends Model
{
    public $timestamps = false;

    protected function casts(): array
    {
        return [
            'unit_prices' => 'array',
            'audio_seconds' => 'float',
            'cost_usd' => 'float',
            'created_at' => 'datetime',
        ];
    }

    protected static function booted(): void
    {
        static::creating(function (AiUsage $usage) {
            $usage->created_at ??= now();
        });
    }

    public function tenant(): BelongsTo
    {
        return $this->belongsTo(Tenant::class);
    }

    public function aiAgent(): BelongsTo
    {
        return $this->belongsTo(AiAgent::class);
    }

    public function contact(): BelongsTo
    {
        return $this->belongsTo(Contact::class);
    }
}
