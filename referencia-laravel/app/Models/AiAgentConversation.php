<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Per (agent, contact) onboarding state - tracks how far the pre-attendance
 * agent has gotten with a lead so it knows when to stop talking and hand
 * off, without duplicating the message content already stored on
 * whatsapp_messages.
 */
#[Fillable([
    'tenant_id',
    'ai_agent_id',
    'contact_id',
    'status',
    'turns_count',
    'opening_completed',
    'classification',
    'handoff_reason',
    'sent_media_ids',
    'started_at',
    'last_inbound_at',
    'followup_step_sent',
    'completed_at',
])]
class AiAgentConversation extends Model
{
    use HasFactory;

    protected $attributes = [
        'status' => 'active',
        'turns_count' => 0,
        'opening_completed' => false,
    ];

    protected function casts(): array
    {
        return [
            'turns_count' => 'integer',
            'followup_step_sent' => 'integer',
            'opening_completed' => 'boolean',
            'started_at' => 'datetime',
            'last_inbound_at' => 'datetime',
            'completed_at' => 'datetime',
            'sent_media_ids' => 'array',
        ];
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
