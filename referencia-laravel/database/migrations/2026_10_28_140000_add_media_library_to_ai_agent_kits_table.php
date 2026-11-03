<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('ai_agent_kits', function (Blueprint $table) {
            // Files the AI may send during onboarding (prova social, an
            // orientation image...): [{id, path, type, mime, file_name,
            // caption, when_to_use, send_on_handoff}] - see
            // AiAgentKitController::storeMedia().
            $table->json('media_library')->nullable()->after('faq');
        });

        Schema::table('ai_agent_conversations', function (Blueprint $table) {
            // media_library item ids already sent in this round, so the
            // same testimonial never goes out twice.
            $table->json('sent_media_ids')->nullable()->after('classification');
        });
    }

    public function down(): void
    {
        Schema::table('ai_agent_kits', function (Blueprint $table) {
            $table->dropColumn('media_library');
        });

        Schema::table('ai_agent_conversations', function (Blueprint $table) {
            $table->dropColumn('sent_media_ids');
        });
    }
};
