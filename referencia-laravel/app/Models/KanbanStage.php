<?php

namespace App\Models;

use App\Enums\KanbanStageRole;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Collection;

#[Fillable(['tenant_id', 'name', 'color', 'role', 'position'])]
class KanbanStage extends Model
{
    use HasFactory;

    protected function casts(): array
    {
        return [
            'role' => KanbanStageRole::class,
        ];
    }

    /**
     * A stage with a role has business logic tied to its identity
     * (KanbanController, WebhookHandler, AiOnboardingAgentRunner, ...) and
     * can never be deleted - only its name/color/position are editable.
     */
    public function isLocked(): bool
    {
        return $this->role !== null;
    }

    public function tenant(): BelongsTo
    {
        return $this->belongsTo(Tenant::class);
    }

    public function contacts(): HasMany
    {
        return $this->hasMany(Contact::class);
    }

    /**
     * Serialize a set of stages to the shape the frontend's `stages` prop
     * expects (mirrors the old ContactStage::board()) - `value` is now the
     * numeric row id instead of an enum slug, and `role` lets the frontend
     * pick out the 4 locked stages without hardcoding a stage id.
     *
     * @param  Collection<int, self>  $stages
     * @return array<int, array{value: int, label: string, color: string, role: ?string}>
     */
    public static function toBoard($stages): array
    {
        return $stages
            ->map(fn (self $stage) => [
                'value' => $stage->id,
                'label' => $stage->name,
                'color' => $stage->color,
                'role' => $stage->role?->value,
            ])
            ->values()
            ->all();
    }
}
