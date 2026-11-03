<?php

namespace App\Console\Commands;

use App\Models\AiAgentConversation;
use App\Services\Ai\AiOnboardingAgentDebouncer;
use App\Services\Ai\AiOnboardingAgentRunner;
use Illuminate\Console\Attributes\Description;
use Illuminate\Console\Attributes\Signature;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Log;

/**
 * A lead who goes quiet mid-onboarding must not sit stuck forever. For each
 * active onboarding conversation, walks the agent's configured follow-up
 * steps (each an optional {step, delay_minutes, message, is_active}) in
 * order: sends any step whose inactivity delay has elapsed and hasn't been
 * sent yet, then - once every active step is sent and
 * followup_final_wait_minutes more has passed with still no reply - gives
 * up and moves the contact to the Lost stage. An agent with no active
 * follow-up steps is left alone entirely: that's the "toggle off" state.
 */
#[Signature('ai-agents:sweep-stale-onboarding')]
#[Description('Send inactivity follow-up steps for onboarding-agent conversations that have gone quiet, and give up once all steps are exhausted.')]
class SweepStaleAiOnboardingConversations extends Command
{
    /**
     * How long past the debounce window an unanswered message from the lead
     * may sit before the sweep re-queues its turn.
     */
    private const LOST_TURN_GRACE_SECONDS = 120;

    public function handle(AiOnboardingAgentRunner $runner, AiOnboardingAgentDebouncer $debouncer): int
    {
        $sent = 0;
        $givenUp = 0;

        AiAgentConversation::query()
            ->where('status', 'active')
            ->whereNotNull('last_inbound_at')
            ->whereHas('aiAgent', fn ($query) => $query->where('is_active', true))
            ->with(['aiAgent', 'contact'])
            ->eachById(function (AiAgentConversation $conversation) use ($runner, $debouncer, &$sent, &$givenUp): void {
                $agent = $conversation->aiAgent;
                $contact = $conversation->contact;

                if (! $agent || ! $contact) {
                    return;
                }

                // The lead spoke last - she's not the one who went quiet, so
                // no "ainda por aí?". If her message is past the debounce
                // window and the runner never picked it up (last_inbound_at
                // is set when a turn starts), the turn was lost - a worker
                // restart, a killed job - and is re-queued instead of leaving
                // her talking to nobody while the follow-ups keep firing.
                $lastMessage = $agent->whatsappAccount?->chats()
                    ->where('customer_phone', $contact->phone)
                    ->first()
                    ?->messages()
                    ->whereNotIn('message_type', ['internal_note', 'reaction', 'sticker'])
                    ->reorder('id', 'desc')
                    ->first();

                if ($lastMessage?->direction === 'inbound') {
                    $waitedSeconds = $lastMessage->created_at->diffInSeconds(now());
                    $unprocessed = $lastMessage->created_at->greaterThan($conversation->last_inbound_at);

                    if ($unprocessed && $waitedSeconds > $agent->debounce_seconds + self::LOST_TURN_GRACE_SECONDS) {
                        Log::warning('AI onboarding turn never ran for an inbound message - re-queued by the sweep', [
                            'agent_id' => $agent->id,
                            'contact_id' => $contact->id,
                            'message_id' => $lastMessage->id,
                        ]);
                        $debouncer->schedule($agent, $contact);
                    }

                    return;
                }

                $activeSteps = collect($agent->followup_steps ?? [])
                    ->filter(fn (array $step) => $step['is_active'] ?? false)
                    ->sortBy('step')
                    ->values();

                if ($activeSteps->isEmpty()) {
                    return;
                }

                $elapsedMinutes = $conversation->last_inbound_at->diffInMinutes(now());
                $stepSent = $conversation->followup_step_sent;

                foreach ($activeSteps as $step) {
                    if ($step['step'] <= $stepSent || $elapsedMinutes < $step['delay_minutes']) {
                        continue;
                    }

                    // Atomic claim - avoids double-sending if a real reply
                    // from the lead races this sweep at the exact boundary.
                    $claimed = AiAgentConversation::query()
                        ->whereKey($conversation->id)
                        ->where('status', 'active')
                        ->where('followup_step_sent', $stepSent)
                        ->update(['followup_step_sent' => $step['step']]);

                    if ($claimed !== 1) {
                        return;
                    }

                    $runner->sendFollowUpMessage($agent, $contact, $step['message']);
                    $stepSent = $step['step'];
                    $sent++;
                }

                $lastStep = $activeSteps->last();
                $giveUpThreshold = $lastStep['delay_minutes'] + ($agent->followup_final_wait_minutes ?? 60);

                if ($stepSent < $lastStep['step'] || $elapsedMinutes < $giveUpThreshold) {
                    return;
                }

                $claimed = AiAgentConversation::query()
                    ->whereKey($conversation->id)
                    ->where('status', 'active')
                    ->update(['status' => 'handing_off']);

                if ($claimed !== 1) {
                    return;
                }

                $runner->giveUpFollowUp($agent, $contact);
                $givenUp++;
            });

        $this->info("Sent {$sent} follow-up step(s), gave up on {$givenUp} conversation(s).");

        return self::SUCCESS;
    }
}
