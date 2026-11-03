<?php

namespace App\Services\Ai;

use App\Models\AiAgent;
use App\Models\AiAgentLog;
use App\Models\AiUsage;
use Illuminate\Support\Collection;

/**
 * Estimated USD spend for an AI agent.
 *
 * Since ai_usages exists, every call is priced once at write time
 * (AiUsageRecorder) and that row is the source of truth. This class still
 * prices the *legacy* AiAgentLog rows written before that table existed
 * (no linked ai_usages row), straight from raw_response.usage against the
 * ai_models catalog - see totalCostUsd().
 */
class AiCostCalculator
{
    public function __construct(private AiModelCatalog $catalog) {}

    /**
     * Total spend for an agent: every ai_usages row plus every legacy log
     * that has no ai_usages row of its own (so no call is counted twice).
     *
     * @param  Collection<int, int>|array<int, int>  $agentIds
     */
    public function agentSpendUsd(AiAgent $agent, iterable $agentIds): float
    {
        $agentIds = collect($agentIds)->all();

        $usageTotal = (float) AiUsage::whereIn('ai_agent_id', $agentIds)->sum('cost_usd');

        $legacyLogs = AiAgentLog::whereIn('ai_agent_id', $agentIds)
            ->whereNotIn('id', AiUsage::whereNotNull('ai_agent_log_id')->select('ai_agent_log_id'))
            ->get(['id', 'step', 'raw_response']);

        return $usageTotal + $this->totalCostUsd($legacyLogs, $agent);
    }

    /**
     * @param  Collection<int, AiAgentLog>|array<int, AiAgentLog>  $logs  Only `step`/`raw_response` are read.
     */
    public function totalCostUsd(iterable $logs, AiAgent $agent): float
    {
        $provider = $agent->provider?->value ?? (string) $agent->provider;
        $total = 0.0;

        foreach ($logs as $log) {
            $total += $log->step === 'transcription'
                ? $this->transcriptionCost($log)
                : $this->chatCallCost($log, $provider, $agent->modelFor($log->step));
        }

        return $total;
    }

    private function chatCallCost(AiAgentLog $log, string $provider, string $modelId): float
    {
        $model = $this->catalog->find($provider, $modelId);
        $usage = is_array($log->raw_response) ? ($log->raw_response['usage'] ?? null) : null;

        if ($model === null || ! is_array($usage)) {
            return 0.0;
        }

        return AiUsageRecorder::cost(AiUsageRecorder::normalizeUsage($provider, $usage), $model->unitPrices());
    }

    private function transcriptionCost(AiAgentLog $log): float
    {
        $raw = is_array($log->raw_response) ? $log->raw_response : [];
        $modelId = $raw['model'] ?? null;
        $seconds = $raw['duration_seconds'] ?? null;
        $model = $modelId !== null ? $this->catalog->find('groq', $modelId) : null;

        if ($model === null || $seconds === null) {
            return 0.0;
        }

        return AiUsageRecorder::cost(['input' => 0, 'cached' => 0, 'output' => 0], $model->unitPrices(), (float) $seconds);
    }
}
