<?php

namespace App\Services\Ai;

use App\Contracts\AiProviderContract;
use App\Enums\AiProvider;
use App\Models\AiAgent;

class AiProviderFactory
{
    public function __construct(
        protected AnthropicProvider $anthropicProvider,
        protected OpenAiProvider $openAiProvider,
        protected DeepSeekProvider $deepSeekProvider,
        protected TogetherProvider $togetherProvider,
    ) {}

    /**
     * Resolve the provider-agnostic client for the given agent's configured provider.
     */
    public function make(AiAgent $agent): AiProviderContract
    {
        return match ($agent->provider) {
            AiProvider::OpenAi => $this->openAiProvider,
            AiProvider::DeepSeek => $this->deepSeekProvider,
            AiProvider::Together => $this->togetherProvider,
            default => $this->anthropicProvider,
        };
    }
}
