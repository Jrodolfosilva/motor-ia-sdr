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
        Schema::table('ai_agents', function (Blueprint $table) {
            $table->text('company_info')->nullable()->after('system_prompt');
            $table->text('greeting_example')->nullable()->after('company_info');
            $table->json('required_fields')->nullable()->after('greeting_example');
            $table->json('classification_labels')->nullable()->after('required_fields');
            $table->text('handoff_message')->nullable()->after('classification_labels');
            $table->unsignedSmallInteger('response_timeout_minutes')->default(10)->after('debounce_seconds');
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('ai_agents', function (Blueprint $table) {
            $table->dropColumn([
                'company_info',
                'greeting_example',
                'required_fields',
                'classification_labels',
                'handoff_message',
                'response_timeout_minutes',
            ]);
        });
    }
};
