<?php

namespace App\Services\Ai\Onboarding;

use App\Models\AiAgent;
use App\Models\Contact;
use App\Models\WhatsappChat;
use App\Models\WhatsappMessage;
use Illuminate\Support\Str;

/**
 * The structured card the attendant reads when the AI hands a lead over -
 * posted as an internal note in the chat (see AiOnboardingAgentRunner::
 * handOff()/disqualify()), so whoever picks the lead up sees the roteiro
 * answers, the files already read and the classification without
 * scrolling back through the whole conversation.
 */
class HandoffBriefing
{
    private const REASONS = [
        'classified' => 'Roteiro completo, classificada pela IA',
        'disqualified' => 'Desqualificada pela IA',
        'media_received' => 'Lead mandou um arquivo que a IA não conseguiu ler',
        'handoff_keyword' => 'Lead pediu para falar com uma pessoa',
        'max_turns_exceeded' => 'Conversa passou do limite de mensagens da IA',
        'turn_failed' => 'Falha técnica da IA - assuma a conversa',
    ];

    /**
     * Files read in the chat - only the most recent ones, matching what
     * the runner itself shows the model.
     */
    private const DOCUMENT_LIMIT = 10;

    public static function build(
        AiAgent $agent,
        Contact $contact,
        ?WhatsappChat $chat,
        string $reason,
        ?string $classification = null,
        ?string $summary = null,
        ?string $confidence = null,
    ): string {
        $lines = ['📋 Resumo da IA para a equipe'];
        $lines[] = 'Motivo: '.(self::REASONS[$reason] ?? $reason);

        if ($classification !== null) {
            $label = collect($agent->classification_labels ?? [])->firstWhere('key', $classification);
            $lines[] = 'Classificação: '.($label['label'] ?? $classification).($confidence ? " (certeza: {$confidence})" : '');
        }

        if ($summary) {
            $lines[] = trim($summary);
        }

        $status = new RequiredFieldsStatus($agent->required_fields ?? [], $contact->custom_fields ?? []);

        $collected = $status->fields
            ->reject(fn (array $field) => $status->missing()->contains('key', $field['key']))
            ->map(fn (array $field) => '• '.self::shortLabel($field['label']).': '.self::formatValue($status->value($field['key'])));
        if ($collected->isNotEmpty()) {
            $lines[] = '';
            $lines[] = 'Dados coletados:';
            array_push($lines, ...$collected->all());
        }

        $missing = $status->missing()->map(fn (array $field) => self::shortLabel($field['label']));
        if ($missing->isNotEmpty()) {
            $lines[] = '';
            $lines[] = 'Faltou perguntar:';
            $lines[] = $missing->implode(', ');
        }

        $documents = self::documents($chat);
        if ($documents !== []) {
            $lines[] = '';
            $lines[] = 'Arquivos lidos pela IA:';
            array_push($lines, ...$documents);
        }

        $formAnswers = $status->unmatched()->map(fn ($value, $key) => "• {$key}: ".self::formatValue($value));
        if ($formAnswers->isNotEmpty()) {
            $lines[] = '';
            $lines[] = 'Outros dados do formulário:';
            array_push($lines, ...$formAnswers->values()->all());
        }

        return implode("\n", $lines);
    }

    /**
     * "Data de saída do último emprego (DD/MM/AAAA; ...)" → "Data de saída
     * do último emprego" - the parenthetical is extraction guidance for
     * the model, noise on the card.
     */
    private static function shortLabel(string $label): string
    {
        return trim(Str::before($label, ' ('));
    }

    private static function formatValue(mixed $value): string
    {
        if (is_array($value)) {
            return collect($value)->map(fn ($item) => is_scalar($item) ? (string) $item : json_encode($item, JSON_UNESCAPED_UNICODE))->implode(', ');
        }

        if (is_bool($value)) {
            return $value ? 'sim' : 'não';
        }

        $text = (string) $value;
        // Only a value that IS a date - a free-text answer that merely
        // mentions one ("admissão em 03/02/2024 e saída em ...") would get
        // the elapsed time of whichever date the parser happened to find.
        $isDate = preg_match('~^\s*(\d{1,2}/)?\d{1,2}/\d{4}\s*$|^\s*\d{4}-\d{2}-\d{2}\s*$~', $text) === 1;
        $elapsed = $isDate ? ClassificationRuleEvaluator::monthsSinceDate($text) : null;

        return $elapsed !== null && $elapsed >= 0
            ? $text.' (há '.$elapsed.' '.($elapsed === 1 ? 'mês' : 'meses').')'
            : $text;
    }

    private const DOCUMENT_NAMES = [
        'cartao_gestante' => 'Cartão da gestante',
        'teste_gravidez' => 'Teste de gravidez',
        'exame_medico' => 'Exame médico',
        'comprovante_residencia' => 'Comprovante de residência',
        'certidao_nascimento' => 'Certidão de nascimento',
        'extrato_inss' => 'Extrato do INSS',
        'print_tela' => 'Print de tela',
        'foto_pessoal' => 'Foto pessoal',
    ];

    /** "ctps" → "CTPS", "cartao_gestante" → "Cartão da gestante". */
    private static function documentName(string $type): string
    {
        return self::DOCUMENT_NAMES[$type] ?? (strlen($type) <= 4 ? strtoupper($type) : Str::headline($type));
    }

    /**
     * @return array<int, string>
     */
    private static function documents(?WhatsappChat $chat): array
    {
        if (! $chat) {
            return [];
        }

        return $chat->messages()
            ->where('direction', 'inbound')
            ->whereNotNull('ai_analysis')
            ->reorder('id', 'desc')
            ->limit(self::DOCUMENT_LIMIT)
            ->get()
            ->reverse()
            ->map(function (WhatsappMessage $message) {
                $analysis = $message->ai_analysis ?? [];
                $kind = $message->message_type === 'image' ? 'imagem' : 'PDF';
                $at = ($message->sent_at ?? $message->created_at)?->timezone(config('app.timezone'))->format('d/m H:i');

                if ($analysis['failed'] ?? false) {
                    return "• {$kind} de {$at}: ⚠️ a IA não conseguiu ler - confira no chat";
                }

                $line = '• '.self::documentName((string) ($analysis['tipo'] ?? 'outro'))." ({$kind}, {$at}): ".trim((string) ($analysis['resumo'] ?? ''));

                return ($analysis['legivel'] ?? true) === false ? $line.' ⚠️ pouco legível' : $line;
            })
            ->values()
            ->all();
    }
}
