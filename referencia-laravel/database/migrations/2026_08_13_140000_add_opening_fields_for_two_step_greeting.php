<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('ai_agents', function (Blueprint $table) {
            // Sent as its own message right after greeting_example, only on
            // a cold lead's (Fluxo B) first turn - "posso te fazer algumas
            // perguntas, tá bem?". When set, the model doesn't speak at all
            // until the lead replies to this; see AiOnboardingAgentRunner.
            $table->text('consent_message')->nullable()->after('greeting_example');
        });

        Schema::table('ai_agent_conversations', function (Blueprint $table) {
            // True once the static opening (greeting, plus consent_message
            // for a cold lead) has been sent and the conversation has moved
            // into real back-and-forth - drives whether the next responder
            // call is told "you haven't spoken yet" or not. Decoupled from
            // turns_count because a cold lead's opening now spans 2 inbound
            // turns (silent consent turn, then the first real reply) while
            // a warm lead's still spans only 1.
            $table->boolean('opening_completed')->default(false)->after('turns_count');
        });
    }

    public function down(): void
    {
        Schema::table('ai_agents', function (Blueprint $table) {
            $table->dropColumn('consent_message');
        });

        Schema::table('ai_agent_conversations', function (Blueprint $table) {
            $table->dropColumn('opening_completed');
        });
    }
};
