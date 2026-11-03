<?php

return [
    /*
    |--------------------------------------------------------------------------
    | AI Tool Library
    |--------------------------------------------------------------------------
    |
    | Read-only catalog of every tool/function currently wired into an LLM
    | call somewhere in the app (see App\Contracts\AiProviderContract::chat()
    | - the $tools array each provider translates into its own vendor's
    | function-calling format). Admin-only reference (AiToolLibraryController)
    | so the team can see what the AI actually has access to today without
    | reading PHP - this is NOT yet a per-tenant on/off switch (that's the
    | next phase, once AiAgent::enabled_tools gets wired up).
    |
    | This list is maintained by hand, not derived automatically - whoever
    | adds a new `tool()`/`buildTool()` method to an agent class (grep for
    | that pattern under app/Services/Ai/) should add a matching row here in
    | the same change, or this page silently goes stale.
    |
    */

    [
        'name' => 'salvar_dado_lead',
        'label' => 'Salvar dado do lead',
        'category' => 'Roteiro',
        'agent' => 'SDR - Extrator (LeadExtractorAgent)',
        'defined_in' => 'app/Services/Ai/Onboarding/LeadExtractorAgent.php',
        'description' => 'Salva um dado do roteiro que o lead já informou em algum ponto da conversa (ex: situação de trabalho, tempo de contribuição).',
        'when_active' => 'Só é oferecida enquanto o roteiro (required_fields) do hub tiver pelo menos um campo ainda não preenchido para aquele lead.',
        'status' => 'active',
    ],
    [
        'name' => 'classificar_lead',
        'label' => 'Classificar lead',
        'category' => 'Qualificação',
        'agent' => 'SDR - Qualificador (LeadQualifierAgent)',
        'defined_in' => 'app/Services/Ai/Onboarding/LeadQualifierAgent.php',
        'description' => 'Classifica o lead com um dos rótulos configurados pelo tenant (ex: Qualificado, Fora do perfil) e encerra o onboarding, passando a conversa para o time humano.',
        'when_active' => 'Só quando o roteiro está 100% completo E o hub tem pelo menos uma classificação cadastrada. As opções de classificação são definidas por tenant, no passo "Qualificação" do Hub de IA.',
        'status' => 'active',
    ],
];
