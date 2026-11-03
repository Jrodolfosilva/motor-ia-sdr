<?php

use App\Services\Ai\AiModelCatalog;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('ai_models', function (Blueprint $table) {
            $table->id();
            // Plain string, not App\Enums\AiProvider - the catalog also
            // prices non-chat providers (e.g. 'groq' for Whisper) that
            // never back an AiAgent.
            $table->string('provider', 50);
            $table->string('model_id', 150);
            $table->string('label');
            $table->json('capabilities')->nullable();
            // USD per 1M tokens / per audio minute - see config/ai_models.php.
            $table->decimal('input_per_mtok', 12, 6)->nullable();
            $table->decimal('cached_input_per_mtok', 12, 6)->nullable();
            $table->decimal('output_per_mtok', 12, 6)->nullable();
            $table->decimal('per_audio_minute', 12, 6)->nullable();
            $table->json('recommended_for')->nullable();
            $table->boolean('is_active')->default(true);
            $table->unsignedSmallInteger('sort_order')->default(0);
            $table->timestamp('price_updated_at')->nullable();
            $table->timestamps();

            $table->unique(['provider', 'model_id']);
        });

        // Seeded here rather than in a seeder so every environment
        // (including production deploys and RefreshDatabase tests) gets
        // the catalog the moment the table exists - the wizard can't offer
        // any model without it.
        app(AiModelCatalog::class)->syncFromConfig();
    }

    public function down(): void
    {
        Schema::dropIfExists('ai_models');
    }
};
