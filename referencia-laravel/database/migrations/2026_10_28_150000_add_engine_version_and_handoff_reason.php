<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('ai_agent_kits', function (Blueprint $table) {
            // Rollout flag for the v2 engine (reads images/PDFs, reply
            // bubbles, reactions, handoff card) - see AiAgent::
            // usesEngineV2(). New kits start on v2.
            $table->string('engine_version', 8)->default('v2')->after('category');
        });

        Schema::table('ai_agent_conversations', function (Blueprint $table) {
            // Why the AI stopped (classified, disqualified, media_received,
            // handoff_keyword, max_turns_exceeded, turn_failed,
            // followup_exhausted) - the rollout metrics in ai:hub-report.
            $table->string('handoff_reason', 40)->nullable()->after('classification');
        });

        // Kits that already exist keep the engine they were tuned on until
        // someone switches them (wizard "Avançado", or ai:apply-kit-template).
        DB::table('ai_agent_kits')->update(['engine_version' => 'v1']);
    }

    public function down(): void
    {
        Schema::table('ai_agent_kits', function (Blueprint $table) {
            $table->dropColumn('engine_version');
        });

        Schema::table('ai_agent_conversations', function (Blueprint $table) {
            $table->dropColumn('handoff_reason');
        });
    }
};
