<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('ai_agents', function (Blueprint $table) {
            $table->id();
            $table->foreignId('tenant_id')->constrained()->cascadeOnDelete();
            $table->foreignId('whatsapp_account_id')->nullable()->constrained()->nullOnDelete();
            $table->string('name');
            $table->string('provider')->default('anthropic');
            $table->string('model');
            // Each tenant supplies their own provider API key - no platform-
            // pooled/shared key. Encrypted at rest (first use of Laravel's
            // 'encrypted' cast in this app).
            $table->text('api_key')->nullable();
            $table->text('system_prompt');
            $table->string('trigger_type')->default('keyword');
            $table->string('trigger_keyword')->default('*');
            $table->string('trigger_match_type')->default('contains');
            $table->string('trigger_stage')->nullable();
            $table->boolean('classifier_enabled')->default(false);
            $table->unsignedSmallInteger('debounce_seconds')->default(8);
            $table->unsignedSmallInteger('max_turns')->default(20);
            $table->json('handoff_keywords')->nullable();
            $table->text('fallback_message')->nullable();
            $table->json('enabled_tools')->nullable();
            $table->boolean('is_active')->default(true);
            $table->boolean('log_executions')->default(true);
            $table->timestamps();

            $table->index(['tenant_id', 'is_active']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('ai_agents');
    }
};
