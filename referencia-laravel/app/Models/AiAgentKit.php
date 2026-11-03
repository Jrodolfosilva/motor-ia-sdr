<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * Groups the (up to 3) role-agents that make up one coordinated pipeline
 * persona for a tenant - see App\Enums\AiAgentRole. Fields shared across
 * every role (company_info, faq) live here instead of being duplicated on
 * each App\Models\AiAgent row.
 */
#[Fillable(['tenant_id', 'name', 'category', 'engine_version', 'company_info', 'faq', 'media_library', 'is_active'])]
class AiAgentKit extends Model
{
    use HasFactory;

    public const ENGINE_VERSIONS = ['v1', 'v2'];

    protected $attributes = [
        'is_active' => true,
        'engine_version' => 'v2',
    ];

    protected function casts(): array
    {
        return [
            'faq' => 'array',
            'media_library' => 'array',
            'is_active' => 'boolean',
        ];
    }

    public function tenant(): BelongsTo
    {
        return $this->belongsTo(Tenant::class);
    }

    public function agents(): HasMany
    {
        return $this->hasMany(AiAgent::class);
    }
}
