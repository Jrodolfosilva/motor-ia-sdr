<?php

namespace App\Services\Ai;

use App\Jobs\RunAiOnboardingAgentTurn;
use App\Models\AiAgent;
use App\Models\Contact;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Str;

/**
 * Coalesces a burst of rapid-fire inbound messages into a single AI turn.
 *
 * No message content is buffered here - each inbound message is already
 * persisted to whatsapp_messages by the webhook handler before this runs,
 * so AiOnboardingAgentRunner::buildHistory() picks up every message in
 * order once the turn actually executes. This class only decides *when*
 * that happens: every new message pushes out a fresh delayed job carrying
 * a one-time token; only the job holding the latest token for this
 * (agent, contact) pair actually runs the turn, all earlier ones see a
 * stale token and no-op.
 *
 * Rides the `Cache` facade rather than a raw `Redis::` client - the
 * `redis` service in docker-compose.yml backs CACHE_STORE (the queue
 * deliberately stayed on `database`, see the compose file's comment), so
 * this already gets real Redis. Staying on the facade instead of calling
 * Redis directly means this class works unchanged in any environment
 * where CACHE_STORE points elsewhere (e.g. local `composer run dev`
 * without the compose stack running).
 */
class AiOnboardingAgentDebouncer
{
    public function schedule(AiAgent $agent, Contact $contact): void
    {
        $token = (string) Str::uuid();
        $ttl = max($agent->debounce_seconds, 1) + 30;

        Cache::put(self::tokenKey($agent->id, $contact->id), $token, now()->addSeconds($ttl));

        RunAiOnboardingAgentTurn::dispatch($agent->id, $contact->id, $token)
            ->delay(now()->addSeconds($agent->debounce_seconds));
    }

    public static function tokenKey(int $agentId, int $contactId): string
    {
        return "ai_onboarding_turn_token:{$agentId}:{$contactId}";
    }
}
