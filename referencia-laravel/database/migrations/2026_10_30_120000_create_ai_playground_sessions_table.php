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
        Schema::create('ai_playground_sessions', function (Blueprint $table) {
            $table->id();
            $table->foreignId('tenant_id')->constrained()->cascadeOnDelete();
            $table->foreignId('ai_agent_kit_id')->constrained()->cascadeOnDelete();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->string('phone', 32);
            $table->json('messages')->nullable();
            $table->json('custom_fields')->nullable();
            $table->string('status')->default('active');
            $table->unsignedInteger('turns_count')->default(0);
            $table->boolean('opening_completed')->default(false);
            $table->json('sent_media_ids')->nullable();
            $table->string('classification')->nullable();
            $table->timestamps();

            $table->unique(['ai_agent_kit_id', 'user_id']);
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('ai_playground_sessions');
    }
};
