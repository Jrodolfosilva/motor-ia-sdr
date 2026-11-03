<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        Schema::create('kanban_stages', function (Blueprint $table) {
            $table->id();
            $table->foreignId('tenant_id')->constrained()->cascadeOnDelete();
            $table->string('name');
            $table->string('color');
            // Null for a tenant's free-form stages. Set only on the 4
            // stages with real business logic attached to their identity
            // (onboarding/in_progress/won/lost, see App\Enums\KanbanStageRole)
            // - those can be renamed/recolored/reordered but never deleted.
            // Postgres allows unlimited NULLs in a unique index, so free
            // stages never collide with each other here.
            $table->string('role')->nullable();
            $table->unsignedInteger('position')->default(0);
            $table->timestamps();

            $table->unique(['tenant_id', 'role']);
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('kanban_stages');
    }
};
