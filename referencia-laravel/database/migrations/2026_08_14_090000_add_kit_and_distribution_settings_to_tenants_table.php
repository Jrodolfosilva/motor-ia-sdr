<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('tenants', function (Blueprint $table) {
            // Gates access to the AI Agent Kit module (routes + nav) for
            // this tenant's own client/agent users - the module has always
            // been admin-only until now, so this defaults closed and the
            // admin opts a tenant in per-client, same idea as the existing
            // resource limits.
            $table->boolean('ai_kit_enabled')->default(false);

            // 'manual' (today's behavior: nobody until an agent picks it up
            // or moves the card) or 'round_robin' (auto-assigned to the
            // tenant's agents in rotation on creation) - see
            // App\Enums\LeadDistributionMode / App\Services\LeadDistributor.
            $table->string('lead_distribution_mode')->default('manual');

            // Internal bookkeeping for round-robin only - index of the next
            // agent (ordered by id) to receive a lead. Never read/written
            // directly by the UI.
            $table->unsignedInteger('lead_distribution_cursor')->default(0);
        });
    }

    public function down(): void
    {
        Schema::table('tenants', function (Blueprint $table) {
            $table->dropColumn(['ai_kit_enabled', 'lead_distribution_mode', 'lead_distribution_cursor']);
        });
    }
};
