<?php

namespace App\Jobs;

use App\Enums\KanbanStageRole;
use App\Models\AiAgent;
use App\Models\Contact;
use App\Services\Ai\AiOnboardingAgentDebouncer;
use App\Services\Ai\AiOnboardingAgentRunner;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Log;

/**
 * Fires one debounced AI onboarding turn. Dispatched with a delay by
 * AiOnboardingAgentDebouncer::schedule() - see that class for why the
 * token check below is the entire debounce mechanism.
 */
class RunAiOnboardingAgentTurn implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    // Retrying wouldn't help anyway: the debounce token below is forgotten
    // before run() executes, so a re-attempt of the same job instance would
    // just no-op on the token check. failed() below is what actually
    // recovers a broken turn.
    public int $tries = 1;

    public function __construct(
        public int $aiAgentId,
        public int $contactId,
        public string $token,
    ) {}

    public function handle(AiOnboardingAgentRunner $runner): void
    {
        $key = AiOnboardingAgentDebouncer::tokenKey($this->aiAgentId, $this->contactId);

        // A newer inbound message superseded this scheduled turn - the job
        // it scheduled will run instead (or already did).
        if (Cache::get($key) !== $this->token) {
            return;
        }

        Cache::forget($key);

        $agent = AiAgent::find($this->aiAgentId);
        $contact = Contact::find($this->contactId);

        if (! $agent || ! $agent->is_active || ! $contact) {
            return;
        }

        $runner->run($agent, $contact);
    }

    /**
     * Without this, a turn that throws (LLM timeout, transient network
     * error, etc.) just dies into failed_jobs - the contact is left
     * silently stuck in Onboarding with no further replies and nothing
     * visible to the tenant. Hand off to a human instead, same as any other
     * "the bot couldn't continue" reason.
     */
    public function failed(\Throwable $exception): void
    {
        Log::error('AI onboarding agent turn failed permanently', [
            'agent_id' => $this->aiAgentId,
            'contact_id' => $this->contactId,
            'error' => $exception->getMessage(),
        ]);

        $agent = AiAgent::find($this->aiAgentId);
        $contact = Contact::find($this->contactId);

        if ($agent && $contact && $contact->kanbanStage?->role === KanbanStageRole::Onboarding) {
            app(AiOnboardingAgentRunner::class)->handOff($agent, $contact, 'turn_failed');
        }
    }
}
