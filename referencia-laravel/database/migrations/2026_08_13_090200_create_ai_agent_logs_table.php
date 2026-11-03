<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('ai_agent_logs', function (Blueprint $table) {
            $table->id();
            $table->foreignId('ai_agent_id')->constrained()->cascadeOnDelete();
            $table->foreignId('contact_id')->constrained()->cascadeOnDelete();
            // Which of the 3 onboarding sub-agents produced this row -
            // extractor/qualifier/responder each build their own system
            // prompt, so one row per turn would lose which prompt actually
            // produced the logged response.
            $table->string('step');
            $table->text('system_prompt');
            $table->text('user_message')->nullable();
            $table->json('raw_response')->nullable();
            $table->timestamp('created_at')->useCurrent();

            $table->index(['contact_id', 'created_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('ai_agent_logs');
    }
};
