<?php

namespace App\Services\Ai;

/**
 * DeepSeek's chat completions API is OpenAI-compatible (same request/
 * response shape) - only the base URL and model names differ.
 */
class DeepSeekProvider extends OpenAiCompatibleProvider
{
    protected function endpoint(): string
    {
        return 'https://api.deepseek.com/chat/completions';
    }
}
