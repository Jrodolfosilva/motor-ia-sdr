<?php

namespace App\Services\Ai\Onboarding;

use App\Models\AiAgent;
use App\Services\Ai\AiProviderFactory;
use App\Support\AiTimeContext;
use Illuminate\Support\Collection;

/**
 * Second of the three onboarding agents. Owns the only decision that ends
 * onboarding: classify-and-hand-off, or keep going. The gate is enforced
 * here in PHP, not left to the model's judgement - the LLM is never even
 * called while a roteiro field is still missing, so it has no chance to
 * classify a lead early just because it decided the conversation "felt"
 * done. This mirrors the "força todas as perguntas" ask: the gate is about
 * which *information* is on the profile, not how many questions were asked
 * or in what order - a field the lead volunteered unprompted (picked up by
 * LeadExtractorAgent) counts the same as one asked directly.
 */
class LeadQualifierAgent
{
    // Near-zero, same reasoning as LeadExtractorAgent::TEMPERATURE - this is
    // the one call that decides classify-vs-keep-going, it should give the
    // same answer for the same roteiro every time, not vary run to run.
    private const TEMPERATURE = 0.1;

    private ?array $lastLog = null;

    public function __construct(private AiProviderFactory $providerFactory) {}

    /**
     * @param  array<int, array{role: string, content: string}>  $history
     * @param  array<string, mixed>  $known
     * @return array{classification: ?string, summary: ?string, confidence: ?string}
     */
    public function decide(AiAgent $agent, array $history, array $known): array
    {
        $this->lastLog = null;

        $labels = collect($agent->classification_labels ?? []);
        if ($labels->isEmpty()) {
            return ['classification' => null, 'summary' => null, 'confidence' => null];
        }

        $status = new RequiredFieldsStatus($agent->required_fields ?? [], $known);
        if (! $status->isComplete()) {
            return ['classification' => null, 'summary' => null, 'confidence' => null];
        }

        // A label with an optional, tenant-configured `rules` condition list
        // (see ClassificationRuleEvaluator) that matches the known fields is
        // decided right here, with no LLM call at all - a mechanical
        // eligibility check (a carência threshold, a categorical vínculo
        // match) shouldn't cost a provider call or have any run-to-run
        // variance. Checked in the order the tenant declared the labels, so
        // a kit author controls precedence by ordering. A label with no
        // `rules` is completely untouched by this - falls through to the
        // LLM exactly as before.
        $ruleMatch = $labels->first(fn (array $label) => ClassificationRuleEvaluator::matches($label['rules'] ?? [], $known));
        if ($ruleMatch !== null) {
            return [
                'classification' => $ruleMatch['key'],
                'summary' => 'Classificado automaticamente por regra.',
                'confidence' => 'alta',
            ];
        }

        $systemPrompt = $this->buildSystemPrompt($agent, $status, $labels);

        $result = $this->providerFactory->make($agent)->chat(
            $agent->api_key,
            $model = $agent->modelFor('qualifier'),
            $history,
            $systemPrompt,
            [$this->tool($labels->pluck('key')->filter()->values()->all())],
            self::TEMPERATURE,
        );

        $this->lastLog = ['system_prompt' => $systemPrompt, 'raw_response' => $result['raw'] ?? null, 'model' => $model];

        foreach ($result['tool_calls'] as $call) {
            if ($call['name'] === 'classificar_lead') {
                return [
                    'classification' => $call['arguments']['classificacao'] ?? 'qualificado',
                    'summary' => $call['arguments']['resumo'] ?? null,
                    'confidence' => $call['arguments']['certeza'] ?? null,
                ];
            }
        }

        return ['classification' => null, 'summary' => null, 'confidence' => null];
    }

    /** @return array{system_prompt: string, raw_response: mixed, model: string}|null */
    public function lastLog(): ?array
    {
        return $this->lastLog;
    }

    /**
     * @param  Collection<int, array{key: string, label: string, description: string}>  $labels
     */
    private function buildSystemPrompt(AiAgent $agent, RequiredFieldsStatus $status, Collection $labels): string
    {
        $fieldLines = $status->fields->map(function (array $field) use ($status) {
            $key = $field['key'] ?? '';

            return "- \"{$field['label']}\": \"{$status->value($key)}\"";
        });
        $labelLines = $labels->map(fn (array $label) => "- {$label['key']}: {$label['label']} - {$label['description']}");

        return implode("\n\n", array_filter([
            $agent->system_prompt,
            AiTimeContext::line(),
            $fieldLines->isNotEmpty()
                ? "Todos os dados do roteiro já foram coletados para este lead:\n".$fieldLines->implode("\n")
                : null,
            "Decida se o lead já pode ser classificado. Chame classificar_lead a menos que a própria conversa deixe claro que falta uma confirmação explícita do lead antes disso (double-check) - nesse caso não chame nenhuma função. Classificações disponíveis:\n".$labelLines->implode("\n"),
            'Além da classificação, informe sua própria certeza nessa decisão (campo certeza: "alta", "media" ou "baixa") - isso não muda o encaminhamento, é só um sinal pra quem for revisar o caso depois saber quais merecem checagem antes de confiar. Use "baixa" sempre que a decisão dependeu de inferir algo que o lead não disse com todas as letras.',
        ]));
    }

    /**
     * Keep config/ai_tool_library.php's 'classificar_lead' row in sync with
     * this definition - that config is the admin-facing tool catalog and
     * isn't derived from this method automatically.
     *
     * @param  array<int, string>  $labelKeys
     * @return array{name: string, description: string, parameters: array<string, mixed>}
     */
    private function tool(array $labelKeys): array
    {
        return [
            'name' => 'classificar_lead',
            'description' => 'Classifica o lead e encerra o onboarding, passando a conversa para o time humano.',
            'parameters' => [
                'type' => 'object',
                'properties' => [
                    'classificacao' => ['type' => 'string', 'enum' => $labelKeys],
                    'resumo' => ['type' => 'string', 'description' => 'Resumo curto do caso para o atendente humano que assume a conversa.'],
                    'certeza' => ['type' => 'string', 'enum' => ['alta', 'media', 'baixa'], 'description' => 'Sua própria confiança nesta classificação - não muda o encaminhamento, é sinal pra revisão humana.'],
                ],
                'required' => ['classificacao'],
            ],
        ];
    }
}
