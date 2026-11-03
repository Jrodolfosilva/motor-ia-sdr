<?php

namespace App\Services\Ai\Onboarding;

use App\Models\AiAgent;
use App\Services\Ai\AiProviderFactory;
use App\Support\AiTimeContext;

/**
 * First of the three onboarding agents. Silently rereads the conversation
 * and pulls out any roteiro field the lead has already given - even out of
 * order, or before the responder agent got a chance to ask for it. Never
 * writes anything the lead sees; its only output is salvar_dado_lead tool
 * calls.
 */
class LeadExtractorAgent
{
    // Near-zero: this is a structured read-the-conversation-and-report task,
    // not a creative one - variance here only means the same conversation
    // sometimes extracts a field and sometimes doesn't.
    private const TEMPERATURE = 0.1;

    private ?array $lastLog = null;

    public function __construct(private AiProviderFactory $providerFactory) {}

    /**
     * @param  array<int, array{role: string, content: string}>  $history
     * @param  array<string, mixed>  $known
     * @return array<string, mixed> newly given/updated field values, keyed by roteiro field key
     */
    public function extract(AiAgent $agent, array $history, array $known): array
    {
        $status = new RequiredFieldsStatus($agent->required_fields ?? [], $known);
        if ($status->fields->isEmpty()) {
            return [];
        }

        $systemPrompt = $this->buildSystemPrompt($status);

        $result = $this->providerFactory->make($agent)->chat(
            $agent->api_key,
            $model = $agent->modelFor('extractor'),
            $history,
            $systemPrompt,
            [$this->tool()],
            self::TEMPERATURE,
        );

        $this->lastLog = ['system_prompt' => $systemPrompt, 'raw_response' => $result['raw'] ?? null, 'model' => $model];

        $collected = [];
        foreach ($result['tool_calls'] as $call) {
            if ($call['name'] !== 'salvar_dado_lead') {
                continue;
            }

            $key = $call['arguments']['campo'] ?? null;
            if ($key) {
                $collected[$key] = $call['arguments']['valor'] ?? null;
            }
        }

        return $collected;
    }

    /** @return array{system_prompt: string, raw_response: mixed, model: string}|null */
    public function lastLog(): ?array
    {
        return $this->lastLog;
    }

    private function buildSystemPrompt(RequiredFieldsStatus $status): string
    {
        $lines = $status->fields->map(function (array $field) use ($status) {
            $key = $field['key'] ?? '';
            $value = $status->value($key);

            return $value !== null && $value !== ''
                ? "- \"{$field['label']}\" (key: \"{$key}\") - já registrado como \"{$value}\"."
                : "- \"{$field['label']}\" (key: \"{$key}\") - ainda não registrado.";
        });

        $parts = [
            'Você é um extrator silencioso de dados de uma conversa de onboarding. Não responde ao lead, não faz perguntas, não escreve texto nenhum - sua única saída são chamadas da função salvar_dado_lead.',
            "Releia a conversa abaixo e, para cada campo do roteiro que o lead já tenha informado (mesmo de forma indireta, fora de ordem, ou sem que ninguém tenha perguntado) e que ainda não esteja registrado - ou cujo valor registrado esteja errado -, chame salvar_dado_lead com a key exata do campo:\n".$lines->implode("\n"),
        ];

        // Form/ad answers land on the profile under free-form keys ("Qual
        // a data prevista do parto") that never match a roteiro key - and
        // the conversation itself rarely repeats them. Without this the
        // responder kept asking, live-tested, for what the form already
        // said (situação de trabalho, previsão do parto).
        $unmatched = $status->unmatched();
        if ($unmatched->isNotEmpty()) {
            $formLines = $unmatched->map(fn ($value, $key) => "- \"{$key}\": \"".(is_scalar($value) ? $value : json_encode($value, JSON_UNESCAPED_UNICODE)).'"');
            $parts[] = "Dados que o lead já informou num formulário/anúncio (chaves livres, não seguem o roteiro):\n".$formLines->implode("\n")."\nSe algum deles responde com clareza um campo do roteiro ainda não registrado, salve esse campo também, com o valor normalizado (ex: \"estou desempregada!\" -> \"desempregada\"; previsão do parto \"Abril 2027\" -> \"04/2027\"). Resposta ambígua ou que não corresponde a nenhum campo: ignore.";
        }

        return implode("\n\n", [
            ...$parts,
            // MediaAnalyzer::historyLine() - a roteiro field can be "the
            // lead sent document X", answered by a file, not by words.
            'Arquivos: linhas entre colchetes como "[Imagem enviado pela lead - ctps: ...]" ou "[PDF enviado pela lead - ultrassom: ...]" descrevem uma foto ou PDF que o lead mandou. Se um campo do roteiro pede um documento, considere-o informado quando houver um arquivo desse tipo e salve um resumo curto do que ele mostra (ex: "CTPS recebida - saída em 20/10/2025"). Os dados lidos no arquivo (datas, empresa) também valem para os outros campos do roteiro.',
            // Without today's date the model can't resolve "dia 15 desse
            // ano" / "mês passado" and saved "15/07 (desse ano)" (ai:bench-sdr).
            AiTimeContext::line(),
            'Datas: salve no formato DD/MM/AAAA sempre que o lead der dia, mês e ano (ou MM/AAAA se der só mês e ano). Datas relativas ("dia 15 de julho desse ano", "mês passado", "ano que vem") viram data completa a partir de hoje.',
            'Se nenhum dado novo ou corrigido apareceu na conversa, não chame nenhuma função.',
        ]);
    }

    /**
     * Keep config/ai_tool_library.php's 'salvar_dado_lead' row in sync with
     * this definition - that config is the admin-facing tool catalog and
     * isn't derived from this method automatically.
     *
     * @return array{name: string, description: string, parameters: array<string, mixed>}
     */
    private function tool(): array
    {
        return [
            'name' => 'salvar_dado_lead',
            'description' => 'Salva um dado do roteiro que o lead já informou em algum ponto da conversa.',
            'parameters' => [
                'type' => 'object',
                'properties' => [
                    'campo' => ['type' => 'string', 'description' => 'Chave (key) exata do campo do roteiro.'],
                    'valor' => ['type' => 'string'],
                ],
                'required' => ['campo', 'valor'],
            ],
        ];
    }
}
