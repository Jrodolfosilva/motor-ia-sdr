<?php

namespace App\Services\Ai\Onboarding;

use App\Models\AiAgent;
use App\Services\Ai\AiProviderFactory;
use App\Support\AiTimeContext;
use App\Support\BrazilianDdd;

/**
 * Third of the three onboarding agents, and the only one that ever writes
 * text the lead sees. Runs whenever the turn doesn't end in a handoff -
 * either because roteiro fields are still missing (LeadQualifierAgent never
 * even ran), or because it ran but decided the lead isn't ready to be
 * classified yet.
 */
class LeadResponderAgent
{
    // Moderate, not near-zero like the extractor/qualifier - this is the
    // only call whose output the lead actually reads, and a colder
    // temperature makes the wording repeat itself across turns/leads in a
    // way that reads as scripted rather than as a person typing.
    private const TEMPERATURE = 0.6;

    private ?array $lastLog = null;

    /** @var array<int, string> */
    private array $lastRequestedMedia = [];

    public function __construct(private AiProviderFactory $providerFactory) {}

    /**
     * @param  array<int, array{role: string, content: string}>  $history
     * @param  array<string, mixed>  $known
     * @param  array<int, string>  $sentMediaIds  media_library ids already sent in this conversation - never offered again.
     */
    public function reply(AiAgent $agent, array $history, array $known, bool $isFirstTurn, ?string $customerPhone = null, array $sentMediaIds = []): string
    {
        $availableMedia = $this->availableMedia($agent, $sentMediaIds);
        $systemPrompt = $this->buildSystemPrompt($agent, $known, $isFirstTurn, $customerPhone, $availableMedia);

        $result = $this->providerFactory->make($agent)->chat(
            $agent->api_key,
            $model = $agent->modelFor('responder'),
            $history,
            $systemPrompt,
            $availableMedia === [] ? [] : [$this->mediaTool($availableMedia)],
            self::TEMPERATURE,
        );

        $this->lastLog = ['system_prompt' => $systemPrompt, 'raw_response' => $result['raw'] ?? null, 'model' => $model];

        $availableIds = array_column($availableMedia, 'id');
        $this->lastRequestedMedia = collect($result['tool_calls'] ?? [])
            ->filter(fn (array $call) => $call['name'] === 'enviar_midia')
            ->pluck('arguments.midia_id')
            ->filter(fn ($id) => in_array($id, $availableIds, true))
            ->unique()
            ->values()
            ->all();

        return trim($result['text']);
    }

    /**
     * media_library ids the model asked to send in the last reply() call,
     * already filtered to items that exist and weren't sent yet.
     *
     * @return array<int, string>
     */
    public function lastRequestedMedia(): array
    {
        return $this->lastRequestedMedia;
    }

    /**
     * Library items the model may still send: not yet sent, and not
     * reserved for the hand-off (those go out automatically there).
     *
     * @param  array<int, string>  $sentMediaIds
     * @return array<int, array<string, mixed>>
     */
    private function availableMedia(AiAgent $agent, array $sentMediaIds): array
    {
        return collect($agent->kit?->media_library ?? [])
            ->reject(fn (array $item) => ! empty($item['send_on_handoff']) || in_array($item['id'] ?? null, $sentMediaIds, true))
            ->values()
            ->all();
    }

    /**
     * @param  array<int, array<string, mixed>>  $availableMedia
     * @return array{name: string, description: string, parameters: array<string, mixed>}
     */
    private function mediaTool(array $availableMedia): array
    {
        return [
            'name' => 'enviar_midia',
            'description' => 'Envia ao lead um arquivo da biblioteca do escritório (ex: depoimentos de clientes). Chame junto com a sua resposta em texto, só quando o momento descrito no item fizer sentido.',
            'parameters' => [
                'type' => 'object',
                'properties' => [
                    'midia_id' => ['type' => 'string', 'enum' => array_column($availableMedia, 'id'), 'description' => 'Id do item da biblioteca.'],
                ],
                'required' => ['midia_id'],
            ],
        ];
    }

    /**
     * The exact system prompt + raw provider response from the most recent
     * reply() call - read by AiOnboardingAgentRunner right after calling
     * this agent, to write the AiAgentLog audit row. Also what the
     * "Ver System Prompt Final Compilado" preview endpoint calls this
     * method for, minus the actual chat() call (see
     * AiAgentKitController::previewPrompt()).
     *
     * @return array{system_prompt: string, raw_response: mixed, model: string}|null
     */
    public function lastLog(): ?array
    {
        return $this->lastLog;
    }

    /**
     * @param  array<int, array<string, mixed>>  $availableMedia  media_library items the model may send this turn (see availableMedia()).
     */
    public function buildSystemPrompt(AiAgent $agent, array $known, bool $isFirstTurn, ?string $customerPhone = null, array $availableMedia = []): string
    {
        $parts = [$agent->system_prompt, AiTimeContext::line($customerPhone)];

        $kit = $agent->kit;
        if ($kit?->company_info) {
            $parts[] = "Informações do escritório/empresa:\n{$kit->company_info}";
        }

        // DDD -> estado é um dado fixo (ANATEL), não algo pra IA "adivinhar".
        // The normal path is deterministic, not prompt-based: when the agent
        // has a greeting_example, AiOnboardingAgentRunner appends the state
        // line to that static first message itself (tested against a real
        // provider - a small/cheap model reliably skipped this instruction
        // when it also had to be told "don't repeat greeting-like content",
        // since it read the state mention as part of the greeting it was
        // told not to repeat). This block only exists as the fallback for a
        // kit with NO greeting_example configured, where nothing else would
        // ever carry the state mention.
        $state = $customerPhone ? BrazilianDdd::stateFor($customerPhone) : null;
        if ($state && $isFirstTurn && ! $agent->greeting_example) {
            $parts[] = "O DDD do lead indica que ele está no estado de {$state['name']} ({$state['uf']}). Inclua isso na sua primeira mensagem: mencione de forma natural que o escritório atua em todo o Brasil, com forte presença ".BrazilianDdd::inState($state).'.';
        }

        // MediaAnalyzer::historyLine() - without this the model tends to
        // answer "recebi a descrição da sua imagem", breaking the persona.
        $parts[] = 'ARQUIVOS DA LEAD: mensagens entre colchetes como "[Imagem enviado pela lead - ...]" ou "[PDF enviado pela lead - ...]" são o que você viu na foto ou no PDF que ela mandou. Reaja como quem olhou o arquivo (ex: confirme a data que aparece nele, comemore o ultrassom), nunca diga que recebeu uma descrição ou um texto automático. Se o arquivo estiver pouco legível, peça com gentileza para reenviar.';

        $status = new RequiredFieldsStatus($agent->required_fields ?? [], $known);

        $parts[] = $status->hasAnyKnownData()
            ? 'ATENÇÃO AO MODO DE ATENDIMENTO: Este lead JÁ preencheu um formulário prévio. NÃO faça perguntas do zero sobre dados que já temos. Cumprimente pelo nome, confirme brevemente os dados recebidos e avance diretamente para a coleta dos campos pendentes.'
            : 'ATENÇÃO AO MODO DE ATENDIMENTO: Este lead NÃO possui cadastro prévio. Faça a recepção calorosa, apresente-se, utilize a mensagem de saudação padrão e colete as informações necessárias UMA pergunta por vez.';

        if (! empty($kit?->faq)) {
            $lines = collect($kit->faq)->map(fn (array $entry) => "- Q: {$entry['question']} | A: {$entry['answer']}");
            $parts[] = "### BASE DE CONHECIMENTO (PERGUNTAS FREQUENTES)\nVocê pode responder às seguintes dúvidas caso o lead pergunte:\n".$lines->implode("\n");
        }

        if ($agent->greeting_example && $isFirstTurn) {
            // The runner already sent this exact text as its own message
            // before calling this agent - repeating or paraphrasing it here
            // would read as the bot greeting the lead twice in a row.
            $parts[] = "Sua saudação inicial (\"{$agent->greeting_example}\") já foi enviada automaticamente como a primeira mensagem, antes desta sua resposta. Não repita nem parafraseie essa saudação de novo, nem abra com um novo cumprimento (\"oi\", \"olá\", \"tudo bem?\") - vá direto para a primeira pergunta do roteiro, mantendo o mesmo tom dela.";
        } elseif ($agent->greeting_example) {
            $parts[] = "Exemplo de tom/apresentação (adapte à conversa, não repita literalmente):\n{$agent->greeting_example}";
        }

        if ($status->fields->isNotEmpty()) {
            $lines = $status->fields->map(function (array $field) use ($status) {
                $key = $field['key'] ?? '';
                $value = $status->value($key);

                // Models don't reliably do date math - a past date gets its
                // elapsed months spelled out, so prompt rules like "se a
                // saída foi há mais de 9 meses, fale da urgência" can fire.
                $elapsed = is_string($value) ? ClassificationRuleEvaluator::monthsSinceDate($value) : null;
                $elapsedNote = $elapsed !== null ? " (há {$elapsed} ".($elapsed === 1 ? 'mês' : 'meses').')' : '';

                return $value !== null && $value !== ''
                    ? "- \"{$field['label']}\" já consta no perfil como \"{$value}\"{$elapsedNote} - apenas confirme com o lead, não pergunte de novo."
                    : "- \"{$field['label']}\" ainda não foi coletado - pergunte algo como: \"{$field['question']}\"";
            });
            $parts[] = "Roteiro de informações a confirmar ou coletar (uma de cada vez, sem soar como formulário):\n".$lines->implode("\n");
        }

        $unmatched = $status->unmatched();
        if ($unmatched->isNotEmpty()) {
            $lines = $unmatched->map(fn ($value, $key) => "- \"{$key}\": \"{$value}\"");
            $parts[] = "Outros dados já registrados no perfil do contato, de origem externa (ex: formulário/anúncio) - as chaves não seguem um padrão fixo, interprete pelo conteúdo:\n".$lines->implode("\n");
        }

        if ($availableMedia !== []) {
            $lines = collect($availableMedia)->map(function (array $item) {
                $caption = ($item['caption'] ?? '') !== '' ? " \"{$item['caption']}\" -" : '';

                return "- id \"{$item['id']}\" ({$item['type']}):{$caption} enviar quando: ".($item['when_to_use'] ?? 'fizer sentido na conversa');
            });
            $parts[] = "BIBLIOTECA DE ARQUIVOS DO ESCRITÓRIO - você pode enviar um destes com a função enviar_midia, junto com sua resposta em texto, quando o momento descrito chegar (cada um no máximo uma vez; não envie vários de uma vez sem motivo):\n".$lines->implode("\n");
        }

        return implode("\n\n", $parts);
    }
}
