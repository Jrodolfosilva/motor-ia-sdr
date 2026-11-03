<?php

namespace App\Console\Commands;

use App\Enums\AiAgentRole;
use App\Models\AiAgent;
use App\Models\AiAgentKit;
use App\Models\Tenant;
use Illuminate\Console\Attributes\Description;
use Illuminate\Console\Attributes\Signature;
use Illuminate\Console\Command;
use Illuminate\Support\Arr;
use Illuminate\Support\Facades\DB;

/**
 * Re-applies a built-in kit template (config/ai_agent_kit_templates.php)
 * to a tenant's *existing* hub - the wizard only offers templates when a
 * hub is first created. Optionally merges a JSON file of tenant-specific
 * overrides on top (real office name, persona, prices...), so that data
 * never has to live in the shared, all-tenants template.
 *
 * Only template-owned fields change. Provider, models, API key, WhatsApp
 * connection and the kit's on/off state are never touched, and each
 * classification label keeps the lost_reason_id/chat_label_id the tenant
 * already mapped for that same key.
 *
 * Overrides JSON shape (any subset): {"kit": {...}, "sdr": {...},
 * "system_prompt_replacements": {"[Nome da atendente]": "Bella"}} - `kit`
 * and `sdr` use the same keys as a template entry (arrays like `faq` or
 * `required_fields` replace the template's list as a whole); the
 * replacements fill the template's placeholders in every agent text field.
 */
#[Signature('ai:apply-kit-template
    {template : Template key, e.g. salario_maternidade}
    {tenant : Tenant id or the tenant\'s email}
    {--overrides= : Path to a JSON file with tenant-specific overrides}
    {--kit= : Hub (ai_agent_kits) id - defaults to the tenant\'s only hub}
    {--dry-run : Show what would change without saving}')]
#[Description('Apply a built-in AI hub template to an existing tenant hub, with optional tenant overrides.')]
class ApplyAiKitTemplate extends Command
{
    /**
     * Template `sdr` keys copied onto the AiAgent as-is.
     */
    private const SDR_FIELDS = [
        'name', 'system_prompt', 'fallback_message', 'greeting_example', 'consent_message',
        'required_fields', 'handoff_message', 'disqualify_message', 'followup_steps', 'followup_final_wait_minutes',
    ];

    public function handle(): int
    {
        $template = collect(config('ai_agent_kit_templates', []))->firstWhere('key', $this->argument('template'));
        if (! $template) {
            $this->error("Template \"{$this->argument('template')}\" not found.");

            return self::FAILURE;
        }

        $overrides = $this->loadOverrides();
        if ($overrides === null) {
            return self::FAILURE;
        }

        $tenant = $this->resolveTenant((string) $this->argument('tenant'));
        if (! $tenant) {
            $this->error("Tenant \"{$this->argument('tenant')}\" not found.");

            return self::FAILURE;
        }

        $kit = $this->resolveKit($tenant);
        $agent = $kit?->agents()->where('role', AiAgentRole::Sdr)->first();
        if (! $kit || ! $agent) {
            $this->error('No AI hub with an SDR agent found for this tenant - create one in the wizard first (it needs the WhatsApp connection and API key), then re-run this. Use --kit=ID if the tenant has several.');

            return self::FAILURE;
        }

        $kitData = array_replace(Arr::only($template['kit'], ['name', 'company_info', 'faq']), Arr::only($overrides['kit'] ?? [], ['name', 'company_info', 'faq']));
        // The templates are written for the v2 engine (files read by the
        // AI, bubbles, handoff card) - applying one switches the hub over.
        $kitData['engine_version'] = 'v2';
        $sdrData = array_replace($template['sdr'], $overrides['sdr'] ?? []);

        $agentAttributes = Arr::only($sdrData, self::SDR_FIELDS);
        if (array_key_exists('handoff_keywords', $sdrData)) {
            $agentAttributes['handoff_keywords'] = is_array($sdrData['handoff_keywords'])
                ? $sdrData['handoff_keywords']
                : collect(explode(',', (string) $sdrData['handoff_keywords']))->map(fn ($k) => trim($k))->filter()->values()->all();
        }
        if (array_key_exists('classification_labels', $sdrData)) {
            $agentAttributes['classification_labels'] = $this->mergeLabelMappings($sdrData['classification_labels'], $agent, $tenant);
        }

        $replacements = $overrides['system_prompt_replacements'] ?? [];
        if (is_array($replacements) && $replacements !== []) {
            // Recursive: placeholders also live inside required_fields
            // questions (e.g. the pitch's "[faixa]"), not only in strings.
            array_walk_recursive($agentAttributes, function (&$value) use ($replacements) {
                if (is_string($value)) {
                    $value = strtr($value, $replacements);
                }
            });
        }

        $this->reportPlaceholders($kitData + $agentAttributes);

        $this->table(['Campo', 'Novo valor'], collect($kitData + $agentAttributes)
            ->map(fn ($value, $key) => [$key, mb_strimwidth(is_string($value) ? $value : json_encode($value, JSON_UNESCAPED_UNICODE), 0, 90, '…')])
            ->values()
            ->all());

        if ($this->option('dry-run')) {
            $this->info("Dry run - nothing saved (hub #{$kit->id}, agent #{$agent->id}).");

            return self::SUCCESS;
        }

        DB::transaction(function () use ($kit, $agent, $kitData, $agentAttributes) {
            $kit->update($kitData);
            $agent->update($agentAttributes);
        });

        $this->info("Template \"{$template['key']}\" applied to hub #{$kit->id} (agent #{$agent->id}).");

        return self::SUCCESS;
    }

    /**
     * @return array<string, mixed>|null
     */
    private function loadOverrides(): ?array
    {
        $path = $this->option('overrides');
        if (! $path) {
            return [];
        }

        if (! is_file($path)) {
            $this->error("Overrides file not found: {$path}");

            return null;
        }

        $decoded = json_decode((string) file_get_contents($path), true);
        if (! is_array($decoded)) {
            $this->error('Overrides file is not valid JSON: '.json_last_error_msg());

            return null;
        }

        return $decoded;
    }

    private function resolveTenant(string $identifier): ?Tenant
    {
        return ctype_digit($identifier)
            ? Tenant::find((int) $identifier)
            : Tenant::where('email', $identifier)->first();
    }

    private function resolveKit(Tenant $tenant): ?AiAgentKit
    {
        if ($this->option('kit')) {
            return $tenant->aiAgentKits()->find((int) $this->option('kit'));
        }

        $kits = $tenant->aiAgentKits()->get();
        if ($kits->count() > 1) {
            $this->warn('Tenant has '.$kits->count().' hubs ('.$kits->pluck('id')->implode(', ').') - pass --kit=ID.');

            return null;
        }

        return $kits->first();
    }

    /**
     * Keeps the tenant's own lost_reason_id/chat_label_id for every label
     * key that already existed on the agent. A disqualify label with no
     * mapping yet falls back to the agent's follow-up lost reason, then
     * to the tenant's first lost reason - an unmapped disqualify label
     * would otherwise fail the wizard's validation the next time anyone
     * saves the hub.
     *
     * @param  array<int, array<string, mixed>>  $labels
     * @return array<int, array<string, mixed>>
     */
    private function mergeLabelMappings(array $labels, AiAgent $agent, Tenant $tenant): array
    {
        $existing = collect($agent->classification_labels ?? [])->keyBy('key');
        $fallbackLostReasonId = $agent->followup_lost_reason_id ?? $tenant->lostReasons()->orderBy('position')->value('id');

        return collect($labels)->map(function (array $label) use ($existing, $fallbackLostReasonId) {
            $previous = $existing->get($label['key']) ?? [];

            foreach (['lost_reason_id', 'chat_label_id'] as $mapping) {
                if (! isset($label[$mapping]) && isset($previous[$mapping])) {
                    $label[$mapping] = $previous[$mapping];
                }
            }

            if (($label['outcome'] ?? 'qualify') === 'disqualify' && empty($label['lost_reason_id'])) {
                $label['lost_reason_id'] = $fallbackLostReasonId;
                $this->warn("Label \"{$label['key']}\" had no lost reason mapped - using #{$fallbackLostReasonId}. Review it in the wizard.");
            }

            return $label;
        })->values()->all();
    }

    /**
     * Template placeholders look like "[Nome do Escritório]" - warn about
     * any left in text the lead will read, so a half-customized hub isn't
     * shipped silently.
     *
     * @param  array<string, mixed>  $data
     */
    private function reportPlaceholders(array $data): void
    {
        preg_match_all('/\[(?!Imagem|PDF)[A-ZÀ-Ú0-9][^\]\n]{1,60}\]/u', json_encode($data, JSON_UNESCAPED_UNICODE), $matches);

        $placeholders = collect($matches[0])->unique()->values();
        if ($placeholders->isNotEmpty()) {
            $this->warn('Placeholders still present: '.$placeholders->implode(', '));
        }
    }
}
