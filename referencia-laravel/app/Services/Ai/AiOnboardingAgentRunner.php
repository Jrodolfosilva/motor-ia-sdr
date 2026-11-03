<?php

namespace App\Services\Ai;

use App\Enums\KanbanStageRole;
use App\Enums\WhatsappProvider;
use App\Models\AiAgent;
use App\Models\AiAgentConversation;
use App\Models\AiAgentLog;
use App\Models\Contact;
use App\Models\KanbanStage;
use App\Models\WhatsappAccount;
use App\Models\WhatsappChat;
use App\Models\WhatsappMessage;
use App\Services\Ai\Onboarding\ClassificationRuleEvaluator;
use App\Services\Ai\Onboarding\HandoffBriefing;
use App\Services\Ai\Onboarding\LeadExtractorAgent;
use App\Services\Ai\Onboarding\LeadQualifierAgent;
use App\Services\Ai\Onboarding\LeadResponderAgent;
use App\Services\Ai\Onboarding\MediaAnalyzer;
use App\Services\Ai\Onboarding\RequiredFieldsStatus;
use App\Services\Inbox\InboxBroadcaster;
use App\Services\WhatsApp\EvolutionApiService;
use App\Services\WhatsApp\WhatsappProviderFactory;
use App\Support\BrazilianDdd;
use App\Support\DurationNormalizer;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;

/**
 * Orchestrates one turn of onboarding across three single-purpose agents,
 * each its own LLM call:
 *
 *  1. LeadExtractorAgent - rereads the conversation, saves any roteiro
 *     field the lead already gave to the contact's profile.
 *  2. LeadQualifierAgent - decides classify-and-hand-off vs. keep going.
 *     Never even called with an incomplete roteiro - see that class.
 *  3. LeadResponderAgent - writes the actual reply to the lead, only run
 *     when the turn isn't ending in a handoff.
 *
 * Never invoked directly from HTTP - always through the debounced
 * RunAiOnboardingAgentTurn job.
 */
class AiOnboardingAgentRunner
{
    private const HISTORY_LIMIT = 40;

    public function __construct(
        private LeadExtractorAgent $extractor,
        private LeadQualifierAgent $qualifier,
        private LeadResponderAgent $responder,
        private MediaAnalyzer $mediaAnalyzer,
    ) {}

    public function run(AiAgent $agent, Contact $contact): void
    {
        // Re-check at execution time, not just at debounce-schedule time -
        // the contact may have already been handed off (e.g. by the
        // timeout sweep, or a human dragging the kanban card) in the
        // window between the message arriving and this job firing.
        if ($contact->kanbanStage?->role !== KanbanStageRole::Onboarding || $contact->automation_paused) {
            return;
        }

        $account = $agent->whatsappAccount;
        if (! $account || ! $agent->api_key) {
            return;
        }

        $chat = $account->chats()->where('customer_phone', $contact->phone)->first();

        $conversation = AiAgentConversation::firstOrNew([
            'ai_agent_id' => $agent->id,
            'contact_id' => $contact->id,
        ]);
        if (! $conversation->exists) {
            $conversation->tenant_id = $agent->tenant_id;
            $conversation->status = 'active';
            $conversation->started_at = now();
        } elseif ($conversation->status !== 'active') {
            // A human dragged the contact back into Onboarding after a
            // previous handoff/timeout - start a fresh round rather than
            // silently resuming a conversation already marked closed.
            $conversation->status = 'active';
            $conversation->turns_count = 0;
            $conversation->opening_completed = false;
            $conversation->classification = null;
            $conversation->sent_media_ids = null;
            $conversation->completed_at = null;
        }
        $conversation->turns_count++;
        $conversation->last_inbound_at = now();
        // Any reply from the lead "unschedules" the pending follow-up
        // sequence - the inactivity clock restarts from this message, so
        // the sweep re-evaluates all steps from scratch next time it goes
        // quiet instead of picking up mid-sequence.
        $conversation->followup_step_sent = 0;
        $conversation->save();

        if ($conversation->turns_count > $agent->max_turns) {
            $this->handOff($agent, $contact, 'max_turns_exceeded');

            return;
        }

        // On a brand-new onboarding round, the configured greeting goes out
        // as its own message before the model's roteiro-starting reply -
        // reads as "hello - then let's get started" instead of the model
        // folding both into one wall-of-text opener.
        //
        // The DDD->estado line is appended here in PHP, not left to the
        // model to add on its own turn - LeadResponderAgent also tells the
        // model "the greeting already went out, don't repeat greeting-like
        // content", which a cheaper model (tested against DeepSeek) reliably
        // interpreted as "skip the state mention too", since it reads as
        // part of the greeting. A deterministic string is the only way to
        // guarantee it actually reaches the lead every time.
        //
        // A cold lead (Fluxo B - no pre-fill data yet) additionally gets a
        // consent_message right after the greeting ("posso te fazer
        // algumas perguntas, tá bem?"), and the model doesn't speak at all
        // on this turn - it only replies once the lead actually responds,
        // which reads as a real back-and-forth instead of the bot jumping
        // straight into an interrogation. A warm lead (Fluxo A, already has
        // some roteiro data - typically from a Meta Ads form) skips this
        // and gets the model's personalized reply immediately, same as
        // before.
        $isFirstTurn = $conversation->turns_count === 1;
        if ($isFirstTurn && $agent->greeting_example) {
            $greeting = $agent->greeting_example;
            $state = BrazilianDdd::stateFor($contact->phone);
            if ($state) {
                $greeting .= ' Atendemos em todo o Brasil, com forte presença '.BrazilianDdd::inState($state).'.';
            }

            $this->sendReply($account, $contact, $chat, $greeting);

            $isColdLead = ! (new RequiredFieldsStatus($agent->required_fields ?? [], $contact->custom_fields ?? []))->hasAnyKnownData();
            if ($isColdLead && $agent->consent_message) {
                $this->sendReply($account, $contact, $chat, $agent->consent_message);

                return;
            }
        }

        if ($chat && $agent->usesEngineV2() && ! $this->analyzePendingMedia($agent, $contact, $chat)) {
            $this->handOff($agent, $contact, 'media_received');

            return;
        }

        $history = $this->buildHistory($chat);
        $lastSeenInboundId = $this->lastInboundId($chat);

        // The greeting above is already persisted, so on a first turn the
        // history ends on our own message. Anthropic treats a trailing
        // assistant turn as a prefill and keeps writing; OpenAI-compatible
        // models (DeepSeek, Together) read it as "already answered" and
        // return an empty reply - tested live, it sent fallback_message on
        // every warm lead's first turn. The responder prompt already says
        // the greeting went out, so dropping it here loses nothing.
        while (! empty($history) && end($history)['role'] === 'assistant') {
            array_pop($history);
        }

        if (empty($history)) {
            return;
        }

        $userMessage = collect($history)->last(fn (array $m) => $m['role'] === 'user')['content'] ?? null;

        // Whether this is the first time the model itself produces a reply
        // in this conversation - not the same as $isFirstTurn once a cold
        // lead's consent step is involved, since that adds one inbound
        // message before the model ever speaks. Read before marking it
        // true so LeadResponderAgent still gets "you haven't greeted yet"
        // exactly once, whichever turn that actually falls on.
        $isFirstResponderTurn = ! $conversation->opening_completed;
        $conversation->update(['opening_completed' => true]);

        try {
            $known = $contact->custom_fields ?? [];
            $collected = $this->extractor->extract($agent, $history, $known);
            $this->logTurn($agent, $contact, 'extractor', $this->extractor->lastLog(), $userMessage);

            if (! empty($collected)) {
                // Canonicalizes "oito meses"/"8 meses"/"há uns 8 meses" down
                // to the same digit form - LeadQualifierAgent only ever
                // reads the stored string, so the same fact worded
                // differently by two leads (or by the same lead across two
                // turns) would otherwise read as different data.
                $collected = collect($collected)
                    ->map(fn ($value) => is_string($value) ? DurationNormalizer::normalize($value) : $value)
                    ->all();

                $known = array_merge($known, $collected);
                $contact->update(['custom_fields' => $known]);
            }

            $decision = $this->qualifier->decide($agent, $history, $known);
            $this->logTurn($agent, $contact, 'qualifier', $this->qualifier->lastLog(), $userMessage);

            if ($decision['classification'] !== null) {
                $label = collect($agent->classification_labels ?? [])->firstWhere('key', $decision['classification']);
                $isDisqualify = ($label['outcome'] ?? 'qualify') === 'disqualify';

                // A disqualification is the one decision here with no way
                // back for the lead - when the tenant configured a `rules`
                // check on this label (ClassificationRuleEvaluator) and the
                // profile doesn't actually satisfy it, the LLM's call alone
                // isn't enough to accept it. Falls through to a normal
                // responder turn instead (conversation just continues), the
                // same as if the model hadn't classified at all this turn -
                // a label with no `rules` configured is unaffected, keeps
                // trusting the LLM exactly as before.
                if ($isDisqualify && ! empty($label['rules']) && ! ClassificationRuleEvaluator::matches($label['rules'], $known)) {
                    Log::info('AI onboarding disqualify rejected by rule check - profile does not satisfy the label\'s own rules', [
                        'agent_id' => $agent->id,
                        'contact_id' => $contact->id,
                        'classification' => $decision['classification'],
                    ]);
                } else {
                    $conversation->update(['classification' => $decision['classification']]);

                    if ($isDisqualify) {
                        $this->disqualify($agent, $contact, $label, $decision['summary'], $decision['confidence']);
                    } else {
                        $this->handOff($agent, $contact, 'classified', $decision['classification'], $decision['summary'], $decision['confidence']);
                    }

                    return;
                }
            }

            $replyText = $this->responder->reply($agent, $history, $known, $isFirstResponderTurn, $contact->phone, $conversation->sent_media_ids ?? []);
            $this->logTurn($agent, $contact, 'responder', $this->responder->lastLog(), $userMessage);
            $requestedMedia = $this->responder->lastRequestedMedia();

            // A turn that only sends a media item (no text) is a valid reply.
            if ($replyText === '' && $requestedMedia === []) {
                // A model that answers with neither text nor a tool call
                // leaves the lead hanging exactly like a hard provider
                // failure would - silence until the follow-up sweep picks
                // it up per the agent's own followup_steps. Routing it
                // through the same catch block below means it
                // gets the same fallback_message + logging instead of
                // going dark.
                throw new \RuntimeException('LeadResponderAgent returned an empty reply');
            }
        } catch (\Throwable $e) {
            Log::error('AI onboarding agent provider call failed', [
                'agent_id' => $agent->id,
                'contact_id' => $contact->id,
                'error' => $e->getMessage(),
            ]);

            if ($agent->fallback_message) {
                $this->sendReply($account, $contact, $chat, $agent->fallback_message);
            }

            return;
        }

        $bubbles = $agent->usesEngineV2() ? self::splitIntoBubbles($replyText) : [$replyText];
        foreach ($bubbles as $bubble) {
            // The lead wrote again while this turn was thinking or typing -
            // the debouncer already queued a new turn that reads her new
            // message, so the rest of this (now stale) reply is dropped
            // instead of landing after her message and answering the
            // previous question twice.
            if ($this->lastInboundId($chat) !== $lastSeenInboundId) {
                return;
            }

            $this->sendReply($account, $contact, $chat, $bubble);
        }

        $this->sendLibraryMedia($agent, $account, $contact, $chat, $conversation, $requestedMedia);
    }

    /**
     * People on WhatsApp send 2-3 short messages, not one block with blank
     * lines in it - the paragraphs the model already writes become separate
     * bubbles, each with its own typing indicator (sendReply()). Capped at
     * 3: anything past the third paragraph stays in the last bubble.
     *
     * @return array<int, string>
     */
    public static function splitIntoBubbles(string $text): array
    {
        $paragraphs = collect(preg_split('/\n\s*\n/u', trim($text)) ?: [])
            ->map(fn (string $paragraph) => trim($paragraph))
            ->filter(fn (string $paragraph) => $paragraph !== '')
            ->values();

        if ($paragraphs->count() <= 3) {
            return $paragraphs->all();
        }

        return [...$paragraphs->take(2)->all(), $paragraphs->slice(2)->implode("\n\n")];
    }

    /**
     * Sends kit media-library items (AiAgentKit::media_library - prova
     * social, an orientation image...) the responder asked for or that are
     * flagged for the hand-off, never the same item twice in one
     * conversation. Each send is a copy under whatsapp-media/ so the
     * media-retention purge (which deletes files referenced by old
     * messages) can never delete the library original.
     *
     * @param  array<int, string>  $itemIds
     */
    private function sendLibraryMedia(AiAgent $agent, WhatsappAccount $account, Contact $contact, ?WhatsappChat $chat, AiAgentConversation $conversation, array $itemIds): void
    {
        $alreadySent = $conversation->sent_media_ids ?? [];
        $items = collect($agent->kit?->media_library ?? [])
            ->filter(fn (array $item) => in_array($item['id'] ?? null, $itemIds, true) && ! in_array($item['id'], $alreadySent, true));

        foreach ($items as $item) {
            try {
                $disk = Storage::disk('public');
                if (! $disk->exists($item['path'])) {
                    continue;
                }

                $copy = 'whatsapp-media/ai_kit_'.Str::random(12).'.'.pathinfo($item['path'], PATHINFO_EXTENSION);
                $disk->copy($item['path'], $copy);

                $result = app(WhatsappProviderFactory::class)->make($account)->sendMediaMessage(
                    $account,
                    $contact->phone,
                    $item['type'],
                    $copy,
                    $item['mime'] ?? null,
                    $item['file_name'] ?? null,
                    ($item['caption'] ?? '') !== '' ? $item['caption'] : null,
                );

                $chat ??= $account->chats()->firstOrCreate(
                    ['customer_phone' => $contact->phone],
                    ['tenant_id' => $account->tenant_id, 'customer_name' => $contact->name, 'last_message_at' => now()]
                );
                $message = $chat->messages()->create([
                    'meta_message_id' => $result['id'] ?? 'ai_agent_'.bin2hex(random_bytes(10)),
                    'direction' => 'outbound',
                    'message_type' => $item['type'],
                    'body' => ($item['caption'] ?? '') !== '' ? $item['caption'] : '['.ucfirst($item['type']).']',
                    'media_url' => $copy,
                    'sent_at' => now(),
                    'status' => 'sent',
                ]);
                InboxBroadcaster::messageCreated($message);

                $alreadySent[] = $item['id'];
            } catch (\Throwable $e) {
                Log::warning('AI agent media library send failed - skipped', [
                    'agent_id' => $agent->id,
                    'item_id' => $item['id'] ?? null,
                    'error' => $e->getMessage(),
                ]);
            }
        }

        $conversation->update(['sent_media_ids' => array_values(array_unique($alreadySent))]);
    }

    /**
     * Fills the {atendente} placeholder of a hand-off line with the first
     * name of whoever the lead is assigned to (round-robin distribution
     * assigns on contact creation - see LeadDistributor), so it reads "a
     * Greice segue com você" instead of naming the whole team.
     */
    private function personalizeHandoff(string $message, Contact $contact): string
    {
        if (! str_contains($message, '{atendente}')) {
            return $message;
        }

        $name = trim((string) $contact->fresh()?->assignedTo?->name);
        $firstName = $name !== '' ? Str::before($name, ' ') : 'nossa equipe';

        return str_replace('{atendente}', $firstName, $message);
    }

    /**
     * Moves the contact out of onboarding into the human queue, closes out
     * the conversation state, and - unless the reason is "the lead sent
     * media/asked for a human before we could even start" - sends the
     * agent's own handoff line so the switch to a human reads as the same
     * conversation continuing, not a bot announcing a transfer.
     */
    public function handOff(AiAgent $agent, Contact $contact, string $reason, ?string $classification = null, ?string $summary = null, ?string $confidence = null): void
    {
        $conversation = AiAgentConversation::firstOrCreate(
            ['ai_agent_id' => $agent->id, 'contact_id' => $contact->id],
            ['tenant_id' => $agent->tenant_id, 'status' => 'active', 'started_at' => now()]
        );
        $conversation->update([
            'status' => 'handed_off',
            'classification' => $classification ?? $conversation->classification,
            'handoff_reason' => $reason,
            'completed_at' => now(),
        ]);

        $stage = $contact->tenant->inProgressKanbanStage();
        $note = $this->noteWithConfidence($summary ?: "Onboarding IA encerrado ({$reason}).", $confidence);
        $this->moveContactToStage($contact, $stage, $note);

        if ($classification !== null) {
            $label = collect($agent->classification_labels ?? [])->firstWhere('key', $classification);
            $this->attachClassificationLabel($agent, $contact, $label);
        }

        $account = $agent->whatsappAccount;
        if ($account && $agent->handoff_message) {
            $chat = $account->chats()->where('customer_phone', $contact->phone)->first();
            $this->sendReply($account, $contact, $chat, $this->personalizeHandoff($agent->handoff_message, $contact));

            $handoffMedia = collect($agent->kit?->media_library ?? [])
                ->filter(fn (array $item) => ! empty($item['send_on_handoff']))
                ->pluck('id')
                ->all();
            if ($handoffMedia !== []) {
                $this->sendLibraryMedia($agent, $account, $contact, $chat, $conversation, $handoffMedia);
            }
        }

        $this->postBriefing($agent, $contact, $reason, $classification, $summary, $confidence);
    }

    /**
     * The disqualify branch of a classification decision (see run()) -
     * mirrors handOff() but routes the contact to the tenant's Lost-role
     * stage with the classification label's own lost reason set, instead of
     * the human "Coleta de Documentos" queue. Each classification label
     * picks its own lost_reason_id (see AiAgentKitController validation),
     * so a report on why leads get disqualified stays as granular as the
     * labels the tenant configured - not one generic bucket.
     *
     * @param  array{key: string, label: string, description?: string, outcome: string, lost_reason_id?: int, disqualify_message?: string}  $label
     */
    public function disqualify(AiAgent $agent, Contact $contact, array $label, ?string $summary = null, ?string $confidence = null): void
    {
        $conversation = AiAgentConversation::firstOrCreate(
            ['ai_agent_id' => $agent->id, 'contact_id' => $contact->id],
            ['tenant_id' => $agent->tenant_id, 'status' => 'active', 'started_at' => now()]
        );
        $conversation->update([
            'status' => 'handed_off',
            'classification' => $label['key'],
            'handoff_reason' => 'disqualified',
            'completed_at' => now(),
        ]);

        $stage = $contact->tenant->lostKanbanStage();
        $note = $this->noteWithConfidence($summary ?: "Onboarding IA: lead desqualificado ({$label['label']}).", $confidence);
        $this->moveContactToStage($contact, $stage, $note, [
            'lost_reason_id' => $label['lost_reason_id'] ?? null,
            'lost_at' => now(),
        ]);

        $this->attachClassificationLabel($agent, $contact, $label);

        $message = $label['disqualify_message'] ?? $agent->disqualify_message;
        $account = $agent->whatsappAccount;
        if ($account && $message) {
            $chat = $account->chats()->where('customer_phone', $contact->phone)->first();
            $this->sendReply($account, $contact, $chat, $message);
        }

        $this->postBriefing($agent, $contact, 'disqualified', $label['key'], $summary, $confidence);
    }

    /**
     * Leaves the HandoffBriefing card as an internal note at the bottom of
     * the chat - never sent to the lead (see InboxController's
     * internal_note branch), and excluded from the AI's own history since
     * buildHistory() only reads text/transcribed/analyzed rows.
     */
    private function postBriefing(AiAgent $agent, Contact $contact, string $reason, ?string $classification, ?string $summary, ?string $confidence): void
    {
        if (! $agent->usesEngineV2()) {
            return;
        }

        $chat = $agent->whatsappAccount?->chats()->where('customer_phone', $contact->phone)->first();
        if (! $chat) {
            return;
        }

        $note = $chat->messages()->create([
            'direction' => 'outbound',
            'message_type' => 'internal_note',
            'body' => HandoffBriefing::build($agent, $contact->fresh(), $chat, $reason, $classification, $summary, $confidence),
            'status' => 'sent',
            'sent_at' => now(),
        ]);

        InboxBroadcaster::messageCreated($note);
    }

    /**
     * Sends one inactivity follow-up step's message (see
     * SweepStaleAiOnboardingConversations) without touching the
     * conversation's status or the contact's kanban stage - the onboarding
     * script is still in progress, the lead just hasn't replied yet.
     */
    public function sendFollowUpMessage(AiAgent $agent, Contact $contact, string $message): void
    {
        $account = $agent->whatsappAccount;
        if (! $account) {
            return;
        }

        $chat = $account->chats()->where('customer_phone', $contact->phone)->first();
        $this->sendReply($account, $contact, $chat, $message);
    }

    /**
     * Called once every configured follow-up step has been sent and the
     * lead still hasn't replied after followup_final_wait_minutes more -
     * mirrors disqualify() but with no message of its own (the 3 follow-ups
     * already said everything there was to say) and using the agent's own
     * followup_lost_reason_id instead of a per-classification-label one.
     */
    public function giveUpFollowUp(AiAgent $agent, Contact $contact): void
    {
        $conversation = AiAgentConversation::firstOrCreate(
            ['ai_agent_id' => $agent->id, 'contact_id' => $contact->id],
            ['tenant_id' => $agent->tenant_id, 'status' => 'active', 'started_at' => now()]
        );
        $conversation->update([
            'status' => 'handed_off',
            'handoff_reason' => 'followup_exhausted',
            'completed_at' => now(),
        ]);

        $stage = $contact->tenant->lostKanbanStage();
        $this->moveContactToStage($contact, $stage, 'Onboarding IA: sem resposta após follow-ups.', [
            'lost_reason_id' => $agent->followup_lost_reason_id,
            'lost_at' => now(),
        ]);
    }

    /**
     * Attaches the classification label's configured chat_label_id (if the
     * tenant mapped one - see AiAgentKitController's chat_label_id
     * validation) to the contact's WhatsappChat. Purely a visual tag on top
     * of the stage move above - entirely optional per label, so a tenant
     * that never mapped one sees no behavior change here.
     *
     * @param  array{chat_label_id?: int|null}|null  $label
     */
    private function attachClassificationLabel(AiAgent $agent, Contact $contact, ?array $label): void
    {
        $chatLabelId = $label['chat_label_id'] ?? null;
        if (! $chatLabelId) {
            return;
        }

        $chat = $agent->whatsappAccount?->chats()->where('customer_phone', $contact->phone)->first();
        $chat?->labels()->syncWithoutDetaching([$chatLabelId]);
    }

    /**
     * Appends the qualifier's self-reported confidence to a hand-off/
     * disqualify note - purely informational for whoever reviews the
     * contact next, never used for routing (see LeadQualifierAgent's
     * `certeza` tool argument).
     */
    private function noteWithConfidence(string $note, ?string $confidence): string
    {
        return $confidence ? "{$note} (certeza da IA: {$confidence})" : $note;
    }

    /**
     * @param  array<string, mixed>  $extra  Additional attributes to set alongside the stage move (e.g. lost_reason_id/lost_at).
     */
    private function moveContactToStage(Contact $contact, ?KanbanStage $stage, string $note, array $extra = []): void
    {
        $attributes = $extra + ['notes' => trim(($contact->notes ? $contact->notes."\n\n" : '').'[Onboarding IA] '.$note)];

        if ($stage) {
            $nextPosition = $contact->tenant->contacts()->where('kanban_stage_id', $stage->id)->max('kanban_position');
            $attributes['kanban_stage_id'] = $stage->id;
            $attributes['kanban_position'] = $nextPosition === null ? 0 : $nextPosition + 1;
        }

        $contact->update($attributes);
    }

    /**
     * Accounts for one sub-agent LLM call: always an ai_usages row (the
     * per-tenant spend record), plus the verbose AiAgentLog row when the
     * agent has logging enabled. $log is null if the sub-agent
     * short-circuited before ever calling the provider (e.g.
     * LeadQualifierAgent bailing out because the roteiro isn't complete
     * yet, or deciding by rule) - nothing was billed in that case.
     *
     * @param  array{system_prompt: string, raw_response: mixed, model: string}|null  $log
     */
    private function logTurn(AiAgent $agent, Contact $contact, string $step, ?array $log, ?string $userMessage): void
    {
        if ($log === null) {
            return;
        }

        $logRow = null;
        if ($agent->log_executions) {
            $logRow = AiAgentLog::create([
                'ai_agent_id' => $agent->id,
                'contact_id' => $contact->id,
                'step' => $step,
                'system_prompt' => $log['system_prompt'],
                'user_message' => $userMessage,
                'raw_response' => $log['raw_response'],
            ]);
        }

        app(AiUsageRecorder::class)->recordChat(
            $agent,
            $contact->id,
            $step,
            $log['model'] ?? $agent->modelFor($step),
            is_array($log['raw_response']) ? $log['raw_response'] : null,
            $logRow?->id,
        );
    }

    /**
     * Closes out any still-active AiAgentConversation row for a contact
     * without touching its kanban_stage/position or sending the bot's own
     * handoff line - unlike handOff(), which is what the bot itself calls
     * to end onboarding. This is for when a human has already taken the
     * contact out of Onboarding by hand (e.g. dragging the kanban card -
     * see KanbanController::move()): re-running handOff()'s stage logic
     * here would stomp whatever stage the human actually chose (which
     * might not be InProgress), and sending the handoff line would be a
     * redundant, possibly confusing message on top of what the human is
     * already doing. Without this, the conversation row sits 'active' with
     * a stale last_inbound_at - every further inbound message from that
     * lead is silently swallowed by the kanban_stage check at the top of
     * run(), and the only thing that eventually closes it out is the
     * follow-up sweep exhausting its steps, potentially much later, with a
     * misleading generic reason.
     */
    public function closeAbandoned(Contact $contact): void
    {
        AiAgentConversation::where('contact_id', $contact->id)
            ->where('status', 'active')
            ->update(['status' => 'handed_off', 'completed_at' => now()]);
    }

    /**
     * Only message types that queue a turn of their own (see
     * WebhookHandler::maybeRunAiOnboardingAgent()) count - a reaction or a
     * sticker doesn't, so it must not cancel the reply in flight.
     */
    private function lastInboundId(?WhatsappChat $chat): ?int
    {
        return $chat?->messages()
            ->where('direction', 'inbound')
            ->whereIn('message_type', ['text', 'audio', 'image', 'document', 'video'])
            ->reorder()
            ->max('id');
    }

    /**
     * What a video becomes in the model's history - the agent can't watch
     * it, but saying so keeps the conversation going instead of the old
     * behavior of handing the lead to a human (who got the "já tenho tudo"
     * handoff line mid-roteiro for a random video).
     */
    public const VIDEO_HISTORY_LINE = '[Vídeo enviado pela lead - você não consegue assistir vídeos. Diga com naturalidade que não conseguiu abrir o vídeo, peça para mandar em foto/print ou escrever, e siga o roteiro]';

    /**
     * @return array<int, array{role: string, content: string}>
     */
    private function buildHistory(?WhatsappChat $chat): array
    {
        if (! $chat) {
            return [];
        }

        // reorder() clears the WhatsappChat::messages() relation's own
        // baked-in orderBy('created_at', 'asc') before applying this
        // method's own ordering - without it, that earlier clause stays as
        // the SQL's primary ORDER BY key and silently wins over the id
        // ordering below (ORDER BY created_at asc, id desc is still
        // created_at-ascending overall), so the "most recent N messages"
        // limit() would cut off the *oldest* messages instead of the
        // intended newest ones. Ordering by id rather than sent_at for the
        // same reason InboxController::messages() does: a burst of several
        // messages landing in the same second (e.g. this agent's own
        // multi-tool-call turn) can share an identical sent_at, and id is
        // the only column guaranteed unique/monotonic to break that tie
        // correctly - getting this wrong scrambles the conversation order
        // the model sees, which reads to it as the lead's confirmation
        // happening before the question it's confirming.
        // A voice note that got transcribed (see WebhookHandler::
        // maybeRunAiOnboardingAgent()) counts as a text turn here even
        // though its message_type stays 'audio' - the inbox still needs
        // that type to render the audio player. An image/PDF the
        // MediaAnalyzer read counts the same way, as its historyLine().
        // Any other non-text row (video, sticker, a file whose analysis
        // failed, an audio whose transcription failed) stays excluded.
        return $chat->messages()
            ->where(fn ($query) => $query->where('message_type', 'text')
                ->orWhere(fn ($query) => $query->where('message_type', 'video')->where('direction', 'inbound'))
                ->orWhereNotNull('transcript')
                ->orWhereNotNull('ai_analysis'))
            ->reorder('id', 'desc')
            ->limit(self::HISTORY_LIMIT)
            ->get()
            ->reverse()
            ->reject(fn (WhatsappMessage $message) => $message->transcript === null && ($message->ai_analysis['failed'] ?? false))
            ->map(fn (WhatsappMessage $message) => [
                'role' => $message->direction === 'outbound' ? 'assistant' : 'user',
                'content' => $message->transcript
                    ?? ($message->ai_analysis !== null ? MediaAnalyzer::historyLine($message, $message->ai_analysis) : null)
                    ?? ($message->message_type === 'video' ? self::VIDEO_HISTORY_LINE : $message->body),
            ])
            ->values()
            ->all();
    }

    /**
     * Reads every inbound image/PDF in the recent window that hasn't been
     * analyzed yet (see MediaAnalyzer) - done here, in the debounced job,
     * rather than in the webhook request, so a burst of several photos is
     * read in one turn and the webhook stays fast. A result is stored on
     * the message either way ({"failed": true} on failure) so a file is
     * never billed twice.
     *
     * @return bool false when at least one new file couldn't be read - the
     *              caller then hands the lead to a human, same as media did
     *              before vision support existed.
     */
    private function analyzePendingMedia(AiAgent $agent, Contact $contact, WhatsappChat $chat): bool
    {
        $pending = $chat->messages()
            ->where('direction', 'inbound')
            ->whereIn('message_type', ['image', 'document'])
            ->whereNull('ai_analysis')
            ->whereNotNull('media_url')
            ->reorder('id', 'desc')
            ->limit(self::HISTORY_LIMIT)
            ->get()
            ->filter(fn (WhatsappMessage $message) => MediaAnalyzer::supports($message))
            ->reverse();

        $allRead = true;

        foreach ($pending as $message) {
            $analysis = $this->mediaAnalyzer->analyze($agent, $message, $contact->id);

            $message->update(['ai_analysis' => $analysis ?? ['failed' => true]]);
            $allRead = $allRead && $analysis !== null;

            if (in_array($analysis['tipo'] ?? null, self::REACT_TO_DOCUMENT_TYPES, true)) {
                $this->react($agent, $contact, $chat, $message, '❤️');
            }
        }

        return $allRead;
    }

    /**
     * Files worth a ❤️ reaction the way the team reacts to them - the
     * pregnancy or the baby, not a CTPS or an RG.
     */
    private const REACT_TO_DOCUMENT_TYPES = ['ultrassom', 'cartao_gestante', 'teste_gravidez', 'certidao_nascimento'];

    /**
     * Best-effort: a failed reaction never blocks the turn. Recorded like
     * an inbox reaction ("Reagiu com ❤️", message_type reaction) so the
     * team sees it in the conversation too.
     */
    private function react(AiAgent $agent, Contact $contact, WhatsappChat $chat, WhatsappMessage $message, string $emoji): void
    {
        $account = $agent->whatsappAccount;
        if (! $account || ! $message->meta_message_id) {
            return;
        }

        try {
            app(WhatsappProviderFactory::class)->make($account)->sendReaction($account, $contact->phone, $message->meta_message_id, $emoji);

            $reaction = $chat->messages()->create([
                'meta_message_id' => 'ai_agent_'.bin2hex(random_bytes(10)),
                'direction' => 'outbound',
                'message_type' => 'reaction',
                'body' => "Reagiu com {$emoji}",
                'reply_to_message_id' => $message->id,
                'sent_at' => now(),
                'status' => 'sent',
            ]);
            InboxBroadcaster::messageCreated($reaction);
        } catch (\Throwable $e) {
            Log::warning('AI agent reaction failed - ignored', [
                'agent_id' => $agent->id,
                'message_id' => $message->id,
                'error' => $e->getMessage(),
            ]);
        }
    }

    private function sendReply(WhatsappAccount $account, Contact $contact, ?WhatsappChat $chat, string $text): void
    {
        $this->simulateTypingOnEvolution($account, $contact->phone, $text);

        app(WhatsappProviderFactory::class)->make($account)->sendTextMessage($account, $contact->phone, $text);

        $chat ??= $account->chats()->firstOrCreate(
            ['customer_phone' => $contact->phone],
            ['tenant_id' => $account->tenant_id, 'customer_name' => $contact->name, 'last_message_at' => now()]
        );

        $message = $chat->messages()->create([
            'meta_message_id' => 'ai_agent_'.bin2hex(random_bytes(10)),
            'direction' => 'outbound',
            'message_type' => 'text',
            'body' => $text,
            'sent_at' => now(),
            'status' => 'sent',
        ]);
        $chat->update(['last_message_at' => now()]);

        InboxBroadcaster::messageCreated($message);
    }

    /**
     * Shows "digitando..." for a few seconds, scaled to roughly how long
     * the reply would take to type, before it actually lands - Meta's Cloud
     * API already does this automatically on every text send
     * (MetaWhatsAppProvider::showTypingIndicator()), Evolution needs it
     * triggered explicitly. Deliberately scoped to just this one call site
     * rather than EvolutionApiService::sendTextMessage() itself: campaigns
     * already have their own configurable typing simulation
     * (Campaign::evolution_typing_enabled, see SendCampaignMessage) that a
     * tenant can turn off for high-volume sends - baking this into every
     * Evolution send unconditionally would double it there and remove that
     * on/off control. Best-effort: a failure here should never block the
     * real reply from sending.
     */
    private function simulateTypingOnEvolution(WhatsappAccount $account, string $to, string $text): void
    {
        if ($account->provider !== WhatsappProvider::Evolution) {
            return;
        }

        $delaySeconds = min(6, max(2, (int) ceil(mb_strlen($text) / 20)));

        try {
            app(EvolutionApiService::class)->sendPresence($account, $to, 'composing', $delaySeconds);

            // Evolution's own `delay` param only tells the recipient's
            // client how long to keep showing the presence it already
            // received - it doesn't pace this request. Without actually
            // waiting here, the real message would land right on top of
            // the composing bubble instead of after it.
            if (! app()->runningUnitTests()) {
                sleep($delaySeconds);
            }
        } catch (\Throwable $e) {
            Log::warning('Evolution typing indicator failed - ignored', [
                'account_id' => $account->id,
                'to' => $to,
                'error' => $e->getMessage(),
            ]);
        }
    }
}
