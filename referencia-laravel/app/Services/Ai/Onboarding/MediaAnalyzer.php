<?php

namespace App\Services\Ai\Onboarding;

use App\Models\AiAgent;
use App\Models\WhatsappMessage;
use App\Services\Ai\AiProviderFactory;
use App\Services\Ai\AiUsageRecorder;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Process;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;

/**
 * Turns an inbound image or PDF into text the onboarding agents can read -
 * the media counterpart of AudioTranscriptionService. One vision-model
 * call per file (AiAgent::visionModel()), answered as structured JSON:
 * what kind of document it is (CTPS, ultrassom, RG...), a one-line
 * summary, and the objective fields legible on it.
 *
 * PDFs try their text layer first (pdftotext - a "CTPS Digital" export
 * has one), and only a scanned PDF with no text falls back to rendering
 * its first pages as images (pdftoppm). Both binaries come from the
 * poppler-utils package in the Dockerfile.
 *
 * Never throws - any failure returns null and the caller keeps the old
 * behavior (hand the lead to a human).
 */
class MediaAnalyzer
{
    // Same reasoning as LeadExtractorAgent: reading a document should give
    // the same answer every time, not vary run to run.
    private const TEMPERATURE = 0.1;

    private const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

    private const PDF_TEXT_PAGES = 3;

    private const PDF_IMAGE_PAGES = 2;

    // A scanned PDF often still yields a few stray characters (page
    // numbers, a watermark) - below this it's treated as having no text.
    private const MIN_PDF_TEXT_CHARS = 80;

    private const MAX_PDF_TEXT_CHARS = 12000;

    public const DOCUMENT_TYPES = [
        'ctps', 'ultrassom', 'cartao_gestante', 'teste_gravidez', 'exame_medico', 'rg', 'cnh', 'cpf',
        'comprovante_residencia', 'certidao_nascimento', 'extrato_inss', 'print_tela', 'foto_pessoal', 'outro',
    ];

    public function __construct(
        private AiProviderFactory $providerFactory,
        private AiUsageRecorder $usageRecorder,
    ) {}

    /**
     * Whether $message is a file this class knows how to read: an inbound
     * image, or an inbound document that is a PDF, with the file on disk.
     */
    public static function supports(WhatsappMessage $message): bool
    {
        $path = $message->getRawOriginal('media_url');

        if ($message->direction !== 'inbound' || ! $path) {
            return false;
        }

        return $message->message_type === 'image'
            || ($message->message_type === 'document' && Str::lower(pathinfo($path, PATHINFO_EXTENSION)) === 'pdf');
    }

    /**
     * @return array{tipo: string, resumo: string, dados: array<string, mixed>, legivel: bool, fonte: string, modelo: string}|null
     */
    public function analyze(AiAgent $agent, WhatsappMessage $message, ?int $contactId = null): ?array
    {
        $model = $agent->visionModel();
        if (! $model || ! $agent->api_key || ! self::supports($message)) {
            return null;
        }

        $path = $message->getRawOriginal('media_url');
        $disk = Storage::disk('public');
        if (! $disk->exists($path)) {
            return null;
        }

        [$images, $pdfText, $source] = $message->message_type === 'image'
            ? [$this->imageInput($path), null, 'imagem']
            : $this->pdfInput($disk->path($path));

        if ($images === [] && $pdfText === null) {
            return null;
        }

        try {
            $result = $this->providerFactory->make($agent)->vision(
                $agent->api_key,
                $model,
                $this->userPrompt($message, $pdfText),
                $images,
                $this->systemPrompt(),
                self::TEMPERATURE,
            );
        } catch (\Throwable $e) {
            Log::warning('AI media analysis failed', [
                'agent_id' => $agent->id,
                'message_id' => $message->id,
                'error' => $e->getMessage(),
            ]);

            return null;
        }

        $this->usageRecorder->recordChat($agent, $contactId, 'vision', $model, $result['raw'] ?? null);

        $parsed = self::parseAnalysis($result['text'] ?? '');
        if ($parsed === null) {
            Log::warning('AI media analysis returned unparseable output', [
                'agent_id' => $agent->id,
                'message_id' => $message->id,
                'output' => Str::limit((string) ($result['text'] ?? ''), 500),
            ]);

            return null;
        }

        return $parsed + ['fonte' => $source, 'modelo' => $model];
    }

    /**
     * The line a successfully analyzed file contributes to the
     * conversation history the onboarding agents read (see
     * AiOnboardingAgentRunner::buildHistory()).
     *
     * @param  array<string, mixed>  $analysis
     */
    public static function historyLine(WhatsappMessage $message, array $analysis): string
    {
        $kind = $message->message_type === 'image' ? 'Imagem' : 'PDF';
        $line = "[{$kind} enviado pela lead - ".($analysis['tipo'] ?? 'outro').': '.trim((string) ($analysis['resumo'] ?? '')).'.';

        $fields = collect($analysis['dados'] ?? [])
            ->filter(fn ($value) => is_scalar($value) && (string) $value !== '')
            ->map(fn ($value, $key) => "{$key}: ".(is_bool($value) ? ($value ? 'sim' : 'não') : $value));
        if ($fields->isNotEmpty()) {
            $line .= ' Dados lidos: '.$fields->implode('; ').'.';
        }

        if (($analysis['legivel'] ?? true) === false) {
            $line .= ' Arquivo pouco legível - peça para reenviar com mais nitidez.';
        }

        $caption = self::caption($message);
        if ($caption !== null) {
            $line .= " Legenda: \"{$caption}\".";
        }

        return $line.']';
    }

    /**
     * @return array{tipo: string, resumo: string, dados: array<string, mixed>, legivel: bool}|null
     */
    public static function parseAnalysis(string $text): ?array
    {
        $start = strpos($text, '{');
        $end = strrpos($text, '}');
        if ($start === false || $end === false || $end < $start) {
            return null;
        }

        $decoded = json_decode(substr($text, $start, $end - $start + 1), true);
        if (! is_array($decoded) || ! isset($decoded['resumo']) || ! is_string($decoded['resumo'])) {
            return null;
        }

        $type = is_string($decoded['tipo'] ?? null) ? Str::snake(Str::ascii($decoded['tipo'])) : 'outro';

        return [
            'tipo' => in_array($type, self::DOCUMENT_TYPES, true) ? $type : 'outro',
            'resumo' => trim($decoded['resumo']),
            'dados' => is_array($decoded['dados'] ?? null) ? $decoded['dados'] : [],
            'legivel' => ($decoded['legivel'] ?? true) !== false,
        ];
    }

    /**
     * The caption the lead typed with the file - null when the stored body
     * is only the "[Image]"/"[Document]" placeholder the webhook handlers
     * write for a file sent without one.
     */
    private static function caption(WhatsappMessage $message): ?string
    {
        $body = trim((string) $message->body);

        return $body === '' || preg_match('/^\[[A-Za-z ]+\]$/', $body) ? null : $body;
    }

    /**
     * @return array<int, array{mime: string, data: string}>
     */
    private function imageInput(string $path): array
    {
        $disk = Storage::disk('public');
        if ($disk->size($path) > self::MAX_IMAGE_BYTES) {
            return [];
        }

        $mime = $disk->mimeType($path) ?: 'image/jpeg';

        return [['mime' => $mime, 'data' => base64_encode($disk->get($path))]];
    }

    /**
     * @return array{0: array<int, array{mime: string, data: string}>, 1: string|null, 2: string}
     */
    private function pdfInput(string $absolutePath): array
    {
        $text = Process::timeout(30)->run([
            'pdftotext', '-l', (string) self::PDF_TEXT_PAGES, '-enc', 'UTF-8', $absolutePath, '-',
        ]);

        if ($text->successful() && mb_strlen(trim($text->output())) >= self::MIN_PDF_TEXT_CHARS) {
            return [[], mb_substr(trim($text->output()), 0, self::MAX_PDF_TEXT_CHARS), 'pdf_texto'];
        }

        $directory = storage_path('app/tmp/pdf-pages/'.Str::uuid());
        File::ensureDirectoryExists($directory);

        try {
            $render = Process::timeout(60)->run([
                'pdftoppm', '-png', '-r', '110', '-f', '1', '-l', (string) self::PDF_IMAGE_PAGES, $absolutePath, $directory.'/page',
            ]);

            if (! $render->successful()) {
                Log::warning('pdftoppm failed - PDF left for a human', ['error' => $render->errorOutput()]);

                return [[], null, 'pdf_imagem'];
            }

            $images = collect(File::glob($directory.'/page*.png'))
                ->sort()
                ->map(fn (string $file) => ['mime' => 'image/png', 'data' => base64_encode(File::get($file))])
                ->values()
                ->all();

            return [$images, null, 'pdf_imagem'];
        } finally {
            File::deleteDirectory($directory);
        }
    }

    private function systemPrompt(): string
    {
        $types = implode(', ', self::DOCUMENT_TYPES);

        return <<<PROMPT
Você analisa arquivos (fotos e PDFs) que leads enviam pelo WhatsApp para um escritório de benefícios do INSS. Responda SOMENTE com um JSON válido, sem nenhum texto fora dele, neste formato:
{"tipo": "...", "resumo": "...", "dados": {}, "legivel": true}

- tipo: exatamente um destes: {$types}.
- resumo: 1 frase em português dizendo o que é o arquivo e o que ele mostra de relevante (ex: "Carteira de trabalho digital com último vínculo encerrado em 20/10/2025").
- dados: só campos objetivos que estejam legíveis, com chaves em snake_case (ex: nome, empresa, data_admissao, data_saida, semanas_gestacao, data_prevista_parto, data_exame, data_nascimento, cidade, cep). Datas em DD/MM/AAAA. Nunca invente nem complete um dado que não aparece.
- legivel: false só se o arquivo estiver borrado, cortado ou escuro a ponto de não dar pra ler o essencial.
PROMPT;
    }

    private function userPrompt(WhatsappMessage $message, ?string $pdfText): string
    {
        $kind = $message->message_type === 'image' ? 'Foto' : 'PDF';
        $prompt = "{$kind} enviado pela lead.";

        $caption = self::caption($message);
        if ($caption !== null) {
            $prompt .= " Legenda que ela escreveu: \"{$caption}\".";
        }

        if ($pdfText !== null) {
            $prompt .= "\n\nTexto extraído do PDF:\n\"\"\"\n{$pdfText}\n\"\"\"";
        }

        return $prompt;
    }
}
