<?php

/**
 * Default AI model catalog - the source the `ai_models` table is seeded
 * from (App\Services\Ai\AiModelCatalog::syncFromConfig(), run by the
 * create_ai_models_table migration and by `php artisan ai:sync-models`).
 *
 * Once seeded, the table is what the app actually reads: the wizard's
 * model selects, the per-role defaults ("só colocar a key e funcionar")
 * and every price snapshot written to `ai_usages`. Editing a price here
 * and re-running the sync updates the table; `ai:sync-models --remote=
 * together` refreshes Together prices straight from its /models API.
 *
 * Prices are USD list prices at the time of writing:
 * - input / cached_input / output: per 1,000,000 tokens
 * - per_audio_minute: speech-to-text, per minute of audio
 *
 * `recommended_for` marks which onboarding roles this model is the
 * provider's default for - exactly one model per (provider, role).
 */
return [

    /*
     * Onboarding roles that can each run on their own model - see
     * App\Models\AiAgent::modelFor(). Order is the order shown in the
     * wizard's "Avançado" section.
     */
    'roles' => [
        'responder' => 'Resposta ao lead',
        'extractor' => 'Extração de dados',
        'qualifier' => 'Qualificação',
        // Only ever filled with a model that has the 'vision' capability -
        // see AiModelCatalog::recommendedFor() / AiAgent::visionModel().
        'vision' => 'Leitura de imagem e PDF',
    ],

    'catalog' => [
        // --- Together AI (OpenAI-compatible, one key for every model) ---
        ['provider' => 'together', 'model_id' => 'deepseek-ai/DeepSeek-V4-Pro-0813', 'label' => 'DeepSeek V4 Pro (recomendado p/ resposta)', 'capabilities' => ['chat', 'tools'], 'input' => 1.32, 'cached_input' => 0.13, 'output' => 3.96, 'recommended_for' => ['responder']],
        ['provider' => 'together', 'model_id' => 'deepseek-ai/DeepSeek-V4.1-Flash', 'label' => 'DeepSeek V4.1 Flash (rápido e barato)', 'capabilities' => ['chat', 'tools'], 'input' => 0.30, 'cached_input' => 0.006, 'output' => 1.20, 'recommended_for' => ['extractor', 'qualifier']],
        ['provider' => 'together', 'model_id' => 'zai-org/GLM-5.3', 'label' => 'GLM-5.3', 'capabilities' => ['chat', 'tools'], 'input' => 1.40, 'cached_input' => 0.26, 'output' => 4.40, 'recommended_for' => []],
        ['provider' => 'together', 'model_id' => 'zai-org/GLM-5.3-Flash', 'label' => 'GLM-5.3 Flash', 'capabilities' => ['chat', 'tools', 'vision'], 'input' => 0.15, 'cached_input' => 0.03, 'output' => 0.50, 'recommended_for' => []],
        ['provider' => 'together', 'model_id' => 'Qwen/Qwen3.7-Plus', 'label' => 'Qwen 3.7 Plus', 'capabilities' => ['chat', 'tools', 'vision'], 'input' => 0.32, 'cached_input' => null, 'output' => 1.28, 'recommended_for' => []],
        ['provider' => 'together', 'model_id' => 'Qwen/Qwen3.8-Flash', 'label' => 'Qwen 3.8 Flash', 'capabilities' => ['chat', 'tools', 'vision'], 'input' => 0.15, 'cached_input' => null, 'output' => 0.47, 'recommended_for' => []],
        ['provider' => 'together', 'model_id' => 'MiniMaxAI/MiniMax-M3.1-Flash', 'label' => 'MiniMax M3.1 Flash', 'capabilities' => ['chat', 'tools', 'vision'], 'input' => 0.15, 'cached_input' => 0.015, 'output' => 0.60, 'recommended_for' => []],
        ['provider' => 'together', 'model_id' => 'openai/gpt-oss-120b', 'label' => 'GPT-OSS 120B', 'capabilities' => ['chat', 'tools'], 'input' => 0.15, 'cached_input' => null, 'output' => 0.60, 'recommended_for' => []],
        ['provider' => 'together', 'model_id' => 'nvidia/NVIDIA-Nemotron-3.5-Super-VL', 'label' => 'Nemotron 3.5 Super VL (visão)', 'capabilities' => ['chat', 'tools', 'vision'], 'input' => 0.15, 'cached_input' => 0.02, 'output' => 0.50, 'recommended_for' => ['vision']],
        ['provider' => 'together', 'model_id' => 'moonshotai/Kimi-K3', 'label' => 'Kimi K3 (premium)', 'capabilities' => ['chat', 'tools', 'vision'], 'input' => 3.00, 'cached_input' => 0.30, 'output' => 15.00, 'recommended_for' => []],

        // --- Anthropic ---
        ['provider' => 'anthropic', 'model_id' => 'claude-haiku-4-5', 'label' => 'Claude Haiku 4.5 (rápido e barato)', 'capabilities' => ['chat', 'tools', 'vision'], 'input' => 1.00, 'cached_input' => 0.10, 'output' => 5.00, 'recommended_for' => ['extractor', 'qualifier', 'vision']],
        ['provider' => 'anthropic', 'model_id' => 'claude-sonnet-5', 'label' => 'Claude Sonnet 5', 'capabilities' => ['chat', 'tools', 'vision'], 'input' => 3.00, 'cached_input' => 0.30, 'output' => 15.00, 'recommended_for' => ['responder']],
        ['provider' => 'anthropic', 'model_id' => 'claude-opus-5', 'label' => 'Claude Opus 5', 'capabilities' => ['chat', 'tools', 'vision'], 'input' => 15.00, 'cached_input' => 1.50, 'output' => 75.00, 'recommended_for' => []],

        // --- OpenAI ---
        ['provider' => 'openai', 'model_id' => 'gpt-4o-mini', 'label' => 'GPT-4o mini (rápido e barato)', 'capabilities' => ['chat', 'tools', 'vision'], 'input' => 0.15, 'cached_input' => 0.075, 'output' => 0.60, 'recommended_for' => ['extractor', 'qualifier', 'vision']],
        ['provider' => 'openai', 'model_id' => 'gpt-4o', 'label' => 'GPT-4o', 'capabilities' => ['chat', 'tools', 'vision'], 'input' => 2.50, 'cached_input' => 1.25, 'output' => 10.00, 'recommended_for' => ['responder']],

        // --- DeepSeek ---
        ['provider' => 'deepseek', 'model_id' => 'deepseek-chat', 'label' => 'DeepSeek Chat (rápido e barato)', 'capabilities' => ['chat', 'tools'], 'input' => 0.28, 'cached_input' => 0.028, 'output' => 0.42, 'recommended_for' => ['responder', 'extractor', 'qualifier']],
        ['provider' => 'deepseek', 'model_id' => 'deepseek-reasoner', 'label' => 'DeepSeek Reasoner', 'capabilities' => ['chat'], 'input' => 0.28, 'cached_input' => 0.028, 'output' => 0.42, 'recommended_for' => []],

        // --- Speech-to-text (not a chat provider - see AudioTranscriptionService) ---
        ['provider' => 'groq', 'model_id' => 'whisper-large-v3-turbo', 'label' => 'Whisper Large v3 Turbo (Groq)', 'capabilities' => ['transcription'], 'per_audio_minute' => 0.04, 'recommended_for' => []],
    ],

];
