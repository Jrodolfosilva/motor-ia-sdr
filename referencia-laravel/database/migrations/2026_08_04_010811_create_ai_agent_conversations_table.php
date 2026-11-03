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
        Schema::create('ai_agent_conversations', function (Blueprint $table) {
            $table->id();
            $table->foreignId('tenant_id')->constrained()->cascadeOnDelete();
            $table->foreignId('ai_agent_id')->constrained()->cascadeOnDelete();
            $table->foreignId('contact_id')->constrained()->cascadeOnDelete();
            // active: agent is still onboarding this lead.
            // handed_off: classification finished (or a handoff keyword/media/timeout
            // rule fired) and the contact left the agent's trigger_stage.
            $table->string('status')->default('active');
            $table->unsignedSmallInteger('turns_count')->default(0);
            $table->string('classification')->nullable();
            $table->timestamp('started_at')->nullable();
            $table->timestamp('last_inbound_at')->nullable();
            $table->timestamp('completed_at')->nullable();
            $table->timestamps();

            // One state row per agent+contact pair - a lead who goes cold and
            // messages again days later resumes the same row instead of
            // starting a duplicate onboarding.
            $table->unique(['ai_agent_id', 'contact_id']);
            $table->index(['status', 'last_inbound_at']);
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('ai_agent_conversations');
    }
};
