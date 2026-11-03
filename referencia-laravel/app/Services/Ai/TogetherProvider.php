<?php

namespace App\Services\Ai;

/**
 * Together AI - one OpenAI-compatible API key giving access to many open
 * models (DeepSeek, Qwen, GLM, Kimi, ...), which is what lets each
 * onboarding role run on its own model under a single tenant key (see
 * AiAgent::modelFor()). Model ids are Together's own namespaced strings,
 * e.g. "deepseek-ai/DeepSeek-V4.1-Flash".
 */
class TogetherProvider extends OpenAiCompatibleProvider
{
    // Larger open models are slower to first token than OpenAI/DeepSeek's
    // own endpoints.
    protected const TIMEOUT_SECONDS = 40;

    protected function endpoint(): string
    {
        return 'https://api.together.xyz/v1/chat/completions';
    }
}
