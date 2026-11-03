<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('ai_agents', function (Blueprint $table) {
            $table->foreignId('ai_agent_kit_id')->nullable()->after('tenant_id')
                ->constrained('ai_agent_kits')->cascadeOnDelete();
            // Only 'sdr' has a wired runtime today (AiOnboardingAgentRunner) -
            // 'document_concierge'/'closing' are reserved for future agents
            // in the same kit, see App\Enums\AiAgentRole.
            $table->string('role')->default('sdr')->after('ai_agent_kit_id');
            $table->text('disqualify_message')->nullable()->after('handoff_message');
            // Promoted to ai_agent_kits.company_info - shared across every
            // role in a kit instead of duplicated per agent.
            $table->dropColumn('company_info');
        });
    }

    public function down(): void
    {
        Schema::table('ai_agents', function (Blueprint $table) {
            $table->dropConstrainedForeignId('ai_agent_kit_id');
            $table->dropColumn(['role', 'disqualify_message']);
            $table->text('company_info')->nullable()->after('system_prompt');
        });
    }
};
