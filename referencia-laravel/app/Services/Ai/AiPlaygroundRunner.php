<?php

namespace App\Services\Ai;

use App\Models\AiAgent;
use App\Models\AiPlaygroundSession;
use App\Models\WhatsappMessage;
use App\Services\Ai\Onboarding\ClassificationRuleEvaluator;
use App\Services\Ai\Onboarding\LeadExtractorAgent;
use App\Services\Ai\Onboarding\LeadQualifierAgent;
use App\Services\Ai\Onboarding\LeadResponderAgent;
use App\Services\Ai\Onboarding\MediaAnalyzer;
use App\Services\Ai\Onboarding\RequiredFieldsStatus;
use App\Support\BrazilianDdd;
use App\Support\DurationNormalizer;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

/**
 * The "Testar IA" sandbox: runs one inbound message from the tester through
 * the same steps a real lead's message goes through - WebhookHandler's
 * pre-checks (audio transcription, handoff keywords, media the agent can't
 * read) and AiOnboardingAgentRunner::run()'s turn (greeting + consent,
 * file reading, extractor -> qualifier -> responder, bubbles, ❤️ reaction,
 * media library) - with the same sub-agents and prompts, but every side
 * effect lands on the AiPlaygroundSession instead: nothing is sent over
 * WhatsApp, no contact/chat/kanban card is touched.
 *
 * Kept in step with AiOnboardingAgentRunner by hand - when a turn rule
 * changes there, mirror it here so the test keeps telling the truth.
 */
class AiPlaygroundRunner
{
    private const HISTORY_LIMIT = 40;

    private const REACT_TO_DOCUMENT_TYPES = ['ultrassom', 'cartao_gestante', 'teste_gravidez', 'certidao_nascimento'];

    public function __construct(
        private LeadExtractorAgent $extractor,
        private LeadQualifierAgent $qualifier,
        private LeadResponderAgent $responder,
        private MediaAnalyzer $mediaAnalyzer,
        private AudioTranscriptionService $transcriber,
        private AiUsageRecorder $usageRecorder,
    ) {}

    /**
     * @param  array{type: string, body: string, media_path?: string|null, file_name?: string|null}  $inbound
     */
    public function handle(AiPlaygroundSession $session, AiAgent $agent, array $inbound): void
    {
        $message = $this->append($session, 'user', $inbound['type'], $inbound['body'], [
            'media_path' => $inbound['media_path'] ?? null,
            'file_name' => $inbound['file_name'] ?? null,
        ]);

        if ($session->status !== 'active') {
            $this->append($session, 'event', 'info', 'A conversa já foi encerrada pela IA - numa conversa real ela não responderia mais. Clique em "Reiniciar" para testar de novo.');
            $session->save();

            return;
        }

        $messageType = $message['type'];

        if ($messageType === 'audio') {
            $transcription = $this->transcriber->transcribe($message['media_path']);

            if ($transcription !== null) {
                $this->updateMessage($session, $message['id'], ['transcript' => $transcription['text']]);
                $this->usageRecorder->recordTranscription($agent, null, 'groq', AudioTranscriptionService::MODEL, $transcription['duration_seconds']);
                $messageType = 'text';
            }
        }

        $readableFile = in_array($messageType, ['image', 'document'], true)
            && $agent->usesEngineV2()
            && $agent->visionModel()
            && MediaAnalyzer::supports($this->asWhatsappMessage($message));

        $continuesOnV2 = in_array($messageType, ['sticker', 'video'], true) && $agent->usesEngineV2();

        if (! $readableFile && $messageType !== 'text' && ! $continuesOnV2) {
            $this->handOff($session, $agent, 'media_received');
            $session->save();

            return;
        }

        if ($messageType === 'text') {
            $text = trim($this->findMessage($session, $message['id'])['transcript'] ?? $message['body']);

            foreach (collect($agent->handoff_keywords ?? [])->filter() as $keyword) {
                if (mb_stripos($text, trim((string) $keyword)) !== false) {
                    $this->handOff($session, $agent, 'handoff_keyword');
                    $session->save();

                    return;
                }
            }
        }

        $this->runTurn($session, $agent);
        $session->save();
    }

    /**
     * Mirrors AiOnboardingAgentRunner::run() from the turn counter on.
     */
    private function runTurn(AiPlaygroundSession $session, AiAgent $agent): void
    {
        $session->turns_count++;

        if ($session->turns_count > $agent->max_turns) {
            $this->handOff($session, $agent, 'max_turns_exceeded');

            return;
        }

        if ($session->turns_count === 1 && $agent->greeting_example) {
            $greeting = $agent->greeting_example;
            $state = BrazilianDdd::stateFor($session->phone);
            if ($state) {
                $greeting .= ' Atendemos em todo o Brasil, com forte presença '.BrazilianDdd::inState($state).'.';
            }

            $this->append($session, 'assistant', 'text', $greeting);

            $isColdLead = ! (new RequiredFieldsStatus($agent->required_fields ?? [], $session->custom_fields ?? []))->hasAnyKnownData();
            if ($isColdLead && $agent->consent_message) {
                $this->append($session, 'assistant', 'text', $agent->consent_message);

                return;
            }
        }

        if ($agent->usesEngineV2() && ! $this->analyzePendingMedia($session, $agent)) {
            $this->handOff($session, $agent, 'media_received');

            return;
        }

        $history = $this->buildHistory($session);
        while (! empty($history) && end($history)['role'] === 'assistant') {
            array_pop($history);
        }

        if (empty($history)) {
            return;
        }

        $isFirstResponderTurn = ! $session->opening_completed;
        $session->opening_completed = true;

        try {
            $known = $session->custom_fields ?? [];
            $collected = $this->extractor->extract($agent, $history, $known);
            $this->recordUsage($agent, $this->extractor->lastLog());

            if (! empty($collected)) {
                $collected = collect($collected)
                    ->map(fn ($value) => is_string($value) ? DurationNormalizer::normalize($value) : $value)
                    ->all();

                $known = array_merge($known, $collected);
                $session->custom_fields = $known;
            }

            $decision = $this->qualifier->decide($agent, $history, $known);
            $this->recordUsage($agent, $this->qualifier->lastLog());

            if ($decision['classification'] !== null) {
                $label = collect($agent->classification_labels ?? [])->firstWhere('key', $decision['classification']);
                $isDisqualify = ($label['outcome'] ?? 'qualify') === 'disqualify';

                if (! ($isDisqualify && ! empty($label['rules']) && ! ClassificationRuleEvaluator::matches($label['rules'], $known))) {
                    $session->classification = $decision['classification'];

                    if ($isDisqualify) {
                        $this->disqualify($session, $agent, $label, $decision['summary'], $decision['confidence']);
                    } else {
                        $this->handOff($session, $agent, 'classified', $decision['classification'], $decision['summary'], $decision['confidence']);
                    }

                    return;
                }
            }

            $replyText = $this->responder->reply($agent, $history, $known, $isFirstResponderTurn, $session->phone, $session->sent_media_ids ?? []);
            $this->recordUsage($agent, $this->responder->lastLog());
            $requestedMedia = $this->responder->lastRequestedMedia();

            if ($replyText === '' && $requestedMedia === []) {
                throw new \RuntimeException('LeadResponderAgent returned an empty reply');
            }
        } catch (\Throwable $e) {
            Log::warning('AI playground turn failed', [
                'agent_id' => $agent->id,
                'session_id' => $session->id,
                'error' => $e->getMessage(),
            ]);

            $this->append($session, 'event', 'info', 'Falha ao chamar o provedor de IA: '.Str::limit($e->getMessage(), 300));
            if ($agent->fallback_message) {
                $this->append($session, 'assistant', 'text', $agent->fallback_message);
            }

            return;
        }

        $bubbles = $agent->usesEngineV2() ? AiOnboardingAgentRunner::splitIntoBubbles($replyText) : [$replyText];
        foreach ($bubbles as $bubble) {
            $this->append($session, 'assistant', 'text', $bubble);
        }

        $this->sendLibraryMedia($session, $agent, $requestedMedia);
    }

    /**
     * @return array<int, array{role: string, content: string}>
     */
    private function buildHistory(AiPlaygroundSession $session): array
    {
        return collect($session->messages ?? [])
            ->filter(fn (array $message) => in_array($message['role'], ['user', 'assistant'], true))
            ->map(function (array $message) {
                if (isset($message['transcript'])) {
                    $content = $message['transcript'];
                } elseif (isset($message['ai_analysis'])) {
                    $content = ($message['ai_analysis']['failed'] ?? false)
                        ? null
                        : MediaAnalyzer::historyLine($this->asWhatsappMessage($message), $message['ai_analysis']);
                } else {
                    $content = match (true) {
                        $message['type'] === 'text' => $message['body'],
                        $message['type'] === 'video' && $message['role'] === 'user' => AiOnboardingAgentRunner::VIDEO_HISTORY_LINE,
                        default => null,
                    };
                }

                return $content === null ? null : ['role' => $message['role'], 'content' => $content];
            })
            ->filter()
            ->take(-self::HISTORY_LIMIT)
            ->values()
            ->all();
    }

    private function analyzePendingMedia(AiPlaygroundSession $session, AiAgent $agent): bool
    {
        $allRead = true;

        foreach ($session->messages ?? [] as $message) {
            if ($message['role'] !== 'user' || ! in_array($message['type'], ['image', 'document'], true) || array_key_exists('ai_analysis', $message)) {
                continue;
            }

            $whatsappMessage = $this->asWhatsappMessage($message);
            if (! MediaAnalyzer::supports($whatsappMessage)) {
                continue;
            }

            $analysis = $this->mediaAnalyzer->analyze($agent, $whatsappMessage);
            $this->updateMessage($session, $message['id'], ['ai_analysis' => $analysis ?? ['failed' => true]]);
            $allRead = $allRead && $analysis !== null;

            if (in_array($analysis['tipo'] ?? null, self::REACT_TO_DOCUMENT_TYPES, true)) {
                $this->append($session, 'assistant', 'reaction', '❤️', ['reply_to' => $message['id']]);
            }
        }

        return $allRead;
    }

    private function handOff(AiPlaygroundSession $session, AiAgent $agent, string $reason, ?string $classification = null, ?string $summary = null, ?string $confidence = null): void
    {
        $session->status = 'handed_off';

        if ($agent->handoff_message) {
            $this->append($session, 'assistant', 'text', str_replace('{atendente}', 'nossa equipe', $agent->handoff_message));

            $handoffMedia = collect($agent->kit?->media_library ?? [])
                ->filter(fn (array $item) => ! empty($item['send_on_handoff']))
                ->pluck('id')
                ->all();
            $this->sendLibraryMedia($session, $agent, $handoffMedia);
        }

        $this->append($session, 'event', 'handoff', $summary ?: "Onboarding IA encerrado ({$reason}).", [
            'reason' => $reason,
            'classification' => $classification,
            'confidence' => $confidence,
        ]);
    }

    /**
     * @param  array<string, mixed>  $label
     */
    private function disqualify(AiPlaygroundSession $session, AiAgent $agent, array $label, ?string $summary, ?string $confidence): void
    {
        $session->status = 'handed_off';

        $message = $label['disqualify_message'] ?? $agent->disqualify_message;
        if ($message) {
            $this->append($session, 'assistant', 'text', $message);
        }

        $this->append($session, 'event', 'disqualify', $summary ?: "Lead desqualificado ({$label['label']}).", [
            'reason' => 'disqualified',
            'classification' => $label['key'],
            'confidence' => $confidence,
        ]);
    }

    /**
     * @param  array<int, string>  $itemIds
     */
    private function sendLibraryMedia(AiPlaygroundSession $session, AiAgent $agent, array $itemIds): void
    {
        $alreadySent = $session->sent_media_ids ?? [];

        collect($agent->kit?->media_library ?? [])
            ->filter(fn (array $item) => in_array($item['id'] ?? null, $itemIds, true) && ! in_array($item['id'], $alreadySent, true))
            ->each(function (array $item) use ($session, &$alreadySent) {
                $this->append($session, 'assistant', $item['type'], ($item['caption'] ?? '') !== '' ? $item['caption'] : '', [
                    'media_path' => $item['path'],
                    'file_name' => $item['file_name'] ?? null,
                ]);
                $alreadySent[] = $item['id'];
            });

        $session->sent_media_ids = array_values(array_unique($alreadySent));
    }

    /**
     * @param  array{system_prompt: string, raw_response: mixed, model: string}|null  $log
     */
    private function recordUsage(AiAgent $agent, ?array $log): void
    {
        if ($log === null) {
            return;
        }

        $this->usageRecorder->recordChat($agent, null, 'test', $log['model'], is_array($log['raw_response']) ? $log['raw_response'] : null);
    }

    /**
     * An unsaved WhatsappMessage carrying just what MediaAnalyzer reads, so
     * the sandbox goes through the exact same file-reading code.
     *
     * @param  array<string, mixed>  $message
     */
    private function asWhatsappMessage(array $message): WhatsappMessage
    {
        return (new WhatsappMessage)->setRawAttributes([
            'direction' => $message['role'] === 'user' ? 'inbound' : 'outbound',
            'message_type' => $message['type'],
            'body' => $message['body'] !== '' ? $message['body'] : '['.ucfirst($message['type']).']',
            'media_url' => $message['media_path'] ?? null,
        ], true);
    }

    /**
     * @param  array<string, mixed>  $extra
     * @return array<string, mixed>
     */
    private function append(AiPlaygroundSession $session, string $role, string $type, string $body, array $extra = []): array
    {
        $message = array_merge([
            'id' => (string) Str::ulid(),
            'role' => $role,
            'type' => $type,
            'body' => $body,
            'created_at' => now()->toIso8601String(),
        ], array_filter($extra, fn ($value) => $value !== null));

        $session->messages = [...($session->messages ?? []), $message];

        return $message;
    }

    /**
     * @return array<string, mixed>|null
     */
    private function findMessage(AiPlaygroundSession $session, string $id): ?array
    {
        return collect($session->messages ?? [])->firstWhere('id', $id);
    }

    /**
     * @param  array<string, mixed>  $changes
     */
    private function updateMessage(AiPlaygroundSession $session, string $id, array $changes): void
    {
        $session->messages = collect($session->messages ?? [])
            ->map(fn (array $message) => $message['id'] === $id ? array_merge($message, $changes) : $message)
            ->all();
    }
}
