<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * One row per LLM call made by a sub-agent (extractor/qualifier/responder)
 * during an onboarding turn - the prompt-transparency audit trail, written
 * only when AiAgent::log_executions is on. No UI reads this yet; it's a
 * database-level "what did the model actually see/say" record for when an
 * agent's reply looks wrong and someone needs to check without guessing.
 */
#[Fillable(['ai_agent_id', 'contact_id', 'step', 'system_prompt', 'user_message', 'raw_response'])]
class AiAgentLog extends Model
{
    public $timestamps = false;

    protected function casts(): array
    {
        return [
            'raw_response' => 'array',
            'created_at' => 'datetime',
        ];
    }

    protected static function booted(): void
    {
        static::creating(function (AiAgentLog $log) {
            $log->created_at ??= now();
        });
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
