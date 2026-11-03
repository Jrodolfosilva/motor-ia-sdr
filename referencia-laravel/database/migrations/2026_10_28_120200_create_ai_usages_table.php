<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('ai_usages', function (Blueprint $table) {
            $table->id();
            $table->foreignId('tenant_id')->constrained()->cascadeOnDelete();
            // Nullable + nullOnDelete: spend already incurred stays on the
            // tenant's bill even after the agent/contact is deleted.
            $table->foreignId('ai_agent_id')->nullable()->constrained()->nullOnDelete();
            $table->foreignId('contact_id')->nullable()->constrained()->nullOnDelete();
            // Set when the same call also wrote a verbose ai_agent_logs row -
            // lets AiCostCalculator tell which legacy logs (written before
            // this table existed) still need pricing from raw_response.
            $table->foreignId('ai_agent_log_id')->nullable()->constrained()->nullOnDelete();
            $table->string('step', 50);
            $table->string('provider', 50);
            $table->string('model_id', 150);
            $table->unsignedInteger('input_tokens')->default(0);
            $table->unsignedInteger('cached_input_tokens')->default(0);
            $table->unsignedInteger('output_tokens')->default(0);
            $table->decimal('audio_seconds', 10, 2)->nullable();
            // Snapshot of the ai_models prices at call time - a later price
            // change never rewrites what an old call cost.
            $table->json('unit_prices')->nullable();
            $table->decimal('cost_usd', 14, 8)->default(0);
            $table->timestamp('created_at')->useCurrent();

            $table->index(['tenant_id', 'created_at']);
            $table->index(['ai_agent_id', 'created_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('ai_usages');
    }
};
