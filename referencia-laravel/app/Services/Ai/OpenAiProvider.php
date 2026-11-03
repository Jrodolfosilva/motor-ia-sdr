<?php

namespace App\Services\Ai;

class OpenAiProvider extends OpenAiCompatibleProvider
{
    protected function endpoint(): string
    {
        return 'https://api.openai.com/v1/chat/completions';
    }
}
