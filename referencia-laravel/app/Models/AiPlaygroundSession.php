<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * One user's sandbox conversation with a hub's SDR agent (see
 * App\Services\Ai\AiPlaygroundRunner) - the "Testar IA" chat. Holds the
 * whole transcript and the lead profile the extractor filled in, so the
 * test behaves like a real multi-turn conversation without a contact,
 * a WhatsApp chat or a kanban card ever being created.
 *
 * `messages` entries: {id, role (user|assistant|event), type (text|image|
 * document|audio|reaction|handoff|disqualify|info), body, media_path?,
 * file_name?, transcript?, ai_analysis?, created_at}.
 */
#[Fillable([
    'tenant_id',
    'ai_agent_kit_id',
    'user_id',
    'phone',
    'messages',
    'custom_fields',
    'status',
    'turns_count',
    'opening_completed',
    'sent_media_ids',
    'classification',
])]
class AiPlaygroundSession extends Model
{
    /** São Paulo demo number - same default the prompt preview uses. */
    public const DEFAULT_PHONE = '+5511999990000';

    protected $attributes = [
        'status' => 'active',
        'turns_count' => 0,
        'opening_completed' => false,
    ];

    protected function casts(): array
    {
        return [
            'messages' => 'array',
            'custom_fields' => 'array',
            'sent_media_ids' => 'array',
            'turns_count' => 'integer',
            'opening_completed' => 'boolean',
        ];
    }

    public function kit(): BelongsTo
    {
        return $this->belongsTo(AiAgentKit::class, 'ai_agent_kit_id');
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
