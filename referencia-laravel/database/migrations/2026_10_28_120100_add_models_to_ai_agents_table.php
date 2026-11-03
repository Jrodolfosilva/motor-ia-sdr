<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('ai_agents', function (Blueprint $table) {
            // Per-role model override ({"responder": ..., "extractor": ...,
            // "qualifier": ...}) - see AiAgent::modelFor(). Null/missing
            // keys fall back to the single `model` column, so every agent
            // created before this keeps running on exactly what it did.
            $table->json('models')->nullable()->after('model');
        });
    }

    public function down(): void
    {
        Schema::table('ai_agents', function (Blueprint $table) {
            $table->dropColumn('models');
        });
    }
};
