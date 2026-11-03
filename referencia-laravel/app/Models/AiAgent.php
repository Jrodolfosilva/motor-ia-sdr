<?php

namespace App\Models;

use App\Enums\AiAgentRole;
use App\Enums\AiProvider;
use App\Services\Ai\AiModelCatalog;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

#[Fillable([
    'tenant_id',
    'ai_agent_kit_id',
    'role',
    'whatsapp_account_id',
    'name',
    'provider',
    'model',
    'models',
    'api_key',
    'system_prompt',
    'greeting_example',
    'consent_message',
    'required_fields',
    'classification_labels',
    'handoff_message',
    'disqualify_message',
    'trigger_type',
    'trigger_keyword',
    'trigger_match_type',
    'trigger_stage_id',
    'classifier_enabled',
    'debounce_seconds',
    'followup_steps',
    'followup_final_wait_minutes',
    'followup_lost_reason_id',
    'max_turns',
    'handoff_keywords',
    'fallback_message',
    'enabled_tools',
    'is_active',
    'log_executions',
])]
class AiAgent extends Model
{
    use HasFactory;

    /**
     * @var array<string, mixed>
     */
    protected $attributes = [
        'is_active' => true,
        'log_executions' => true,
    ];

    protected function casts(): array
    {
        return [
            'role' => AiAgentRole::class,
            'provider' => AiProvider::class,
            'api_key' => 'encrypted',
            'models' => 'array',
            'required_fields' => 'array',
            'classification_labels' => 'array',
            'followup_steps' => 'array',
            'classifier_enabled' => 'boolean',
            'handoff_keywords' => 'array',
            'enabled_tools' => 'array',
            'is_active' => 'boolean',
            'log_executions' => 'boolean',
        ];
    }

    /**
     * The model id one onboarding role (responder/extractor/qualifier -
     * see config('ai_models.roles')) runs on. A role with no override in
     * `models` uses the agent's single `model`, which is what every agent
     * created before per-role models existed relies on.
     */
    public function modelFor(string $role): string
    {
        $override = $this->models[$role] ?? null;

        return is_string($override) && $override !== '' ? $override : (string) $this->model;
    }

    /**
     * The model that reads inbound images/PDFs: the explicit `vision`
     * override, else the provider's recommended vision model. Null when
     * the provider has none (e.g. DeepSeek) - media then still goes
     * straight to a human, same as before vision support existed.
     */
    public function visionModel(): ?string
    {
        $override = $this->models['vision'] ?? null;
        if (is_string($override) && $override !== '') {
            return $override;
        }

        $provider = $this->provider?->value ?? (string) $this->provider;

        return app(AiModelCatalog::class)->recommendedFor($provider)['vision'] ?? null;
    }

    /**
     * Whether this agent's kit runs the v2 onboarding engine: reads
     * images/PDFs instead of handing off, splits replies into bubbles,
     * reacts to pregnancy files, ignores stickers and posts the handoff
     * card. v1 kits keep the pre-v2 behavior (see the engine_version
     * migration).
     */
    public function usesEngineV2(): bool
    {
        return ($this->kit?->engine_version ?? 'v2') === 'v2';
    }

    public function tenant(): BelongsTo
    {
        return $this->belongsTo(Tenant::class);
    }

    public function kit(): BelongsTo
    {
        return $this->belongsTo(AiAgentKit::class, 'ai_agent_kit_id');
    }

    public function whatsappAccount(): BelongsTo
    {
        return $this->belongsTo(WhatsappAccount::class);
    }

    public function triggerStage(): BelongsTo
    {
        return $this->belongsTo(KanbanStage::class, 'trigger_stage_id');
    }

    public function conversations(): HasMany
    {
        return $this->hasMany(AiAgentConversation::class);
    }

    public function logs(): HasMany
    {
        return $this->hasMany(AiAgentLog::class);
    }
}
