<?php

namespace App\Enums;

use App\Services\Ai\AiModelCatalog;

enum AiProvider: string
{
    // Listed first on purpose: options()[0] is the wizard's default
    // provider, and Together's single key covers every onboarding role.
    case Together = 'together';
    case Anthropic = 'anthropic';
    case OpenAi = 'openai';
    case DeepSeek = 'deepseek';

    /**
     * Human-readable label for UI display.
     */
    public function label(): string
    {
        return match ($this) {
            self::Together => 'Together AI (recomendado - vários modelos, 1 chave)',
            self::Anthropic => 'Anthropic (Claude)',
            self::OpenAi => 'OpenAI',
            self::DeepSeek => 'DeepSeek',
        };
    }

    /**
     * Model choices offered in the UI for this provider, read from the
     * ai_models catalog (see config/ai_models.php).
     *
     * @return array<int, array{value: string, label: string}>
     */
    public function models(): array
    {
        return app(AiModelCatalog::class)->optionsFor($this->value);
    }

    /**
     * All providers with their model choices and per-role defaults, for
     * the UI's provider picker.
     *
     * @return array<int, array{value: string, label: string, models: array<int, array{value: string, label: string}>, recommended: array<string, string>}>
     */
    public static function options(): array
    {
        $catalog = app(AiModelCatalog::class);

        return array_map(
            fn (self $provider) => [
                'value' => $provider->value,
                'label' => $provider->label(),
                'models' => $catalog->optionsFor($provider->value),
                'recommended' => $catalog->recommendedFor($provider->value),
            ],
            self::cases()
        );
    }
}
