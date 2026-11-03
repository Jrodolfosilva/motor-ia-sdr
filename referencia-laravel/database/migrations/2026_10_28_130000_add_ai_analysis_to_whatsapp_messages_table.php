<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('whatsapp_messages', function (Blueprint $table) {
            // What the AI onboarding agent "saw" in an inbound image/PDF
            // (App\Services\Ai\Onboarding\MediaAnalyzer) - the media-file
            // counterpart of `transcript` for voice notes. message_type
            // stays image/document so the inbox still renders the file.
            $table->json('ai_analysis')->nullable()->after('transcript');
        });
    }

    public function down(): void
    {
        Schema::table('whatsapp_messages', function (Blueprint $table) {
            $table->dropColumn('ai_analysis');
        });
    }
};
