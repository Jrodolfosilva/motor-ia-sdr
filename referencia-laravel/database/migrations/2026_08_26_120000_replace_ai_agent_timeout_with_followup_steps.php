<?php

use App\Models\AiAgent;
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
        Schema::table('ai_agents', function (Blueprint $table) {
            $table->json('followup_steps')->nullable()->after('response_timeout_minutes');
            $table->unsignedSmallInteger('followup_final_wait_minutes')->nullable()->after('followup_steps');
            $table->foreignId('followup_lost_reason_id')->nullable()->after('followup_final_wait_minutes')
                ->constrained('lost_reasons')->nullOnDelete();
        });

        // Preserve the current single-timeout behavior as "step 1" so no
        // agent silently loses its timeout handoff the moment this ships -
        // the admin can then split it into up to 3 steps from the wizard.
        AiAgent::query()->whereNull('followup_steps')->each(function (AiAgent $agent): void {
            $agent->update([
                'followup_steps' => [[
                    'step' => 1,
                    'delay_minutes' => $agent->response_timeout_minutes,
                    'message' => $agent->handoff_message ?? '',
                    'is_active' => true,
                ]],
                'followup_final_wait_minutes' => 60,
            ]);
        });

        Schema::table('ai_agents', function (Blueprint $table) {
            $table->dropColumn('response_timeout_minutes');
        });

        Schema::table('ai_agent_conversations', function (Blueprint $table) {
            $table->unsignedTinyInteger('followup_step_sent')->default(0)->after('last_inbound_at');
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('ai_agents', function (Blueprint $table) {
            $table->unsignedSmallInteger('response_timeout_minutes')->default(10)->after('debounce_seconds');
        });

        AiAgent::query()->each(function (AiAgent $agent): void {
            $firstStep = collect($agent->followup_steps ?? [])->firstWhere('step', 1);
            $agent->update([
                'response_timeout_minutes' => $firstStep['delay_minutes'] ?? 10,
            ]);
        });

        Schema::table('ai_agents', function (Blueprint $table) {
            $table->dropConstrainedForeignId('followup_lost_reason_id');
            $table->dropColumn(['followup_steps', 'followup_final_wait_minutes']);
        });

        Schema::table('ai_agent_conversations', function (Blueprint $table) {
            $table->dropColumn('followup_step_sent');
        });
    }
};
