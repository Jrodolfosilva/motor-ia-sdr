<?php

return [
    /*
    |--------------------------------------------------------------------------
    | AI Agent Kit Categories
    |--------------------------------------------------------------------------
    |
    | Suggested categories offered in the kit wizard's category picker -
    | purely a UX list, not a DB-enforced enum (ai_agent_kits.category is a
    | plain string). A tenant can always type a custom category the wizard
    | doesn't suggest yet; add an entry here to make a new vertical show up
    | as a first-class option without any migration.
    |
    */

    ['value' => 'salario_maternidade', 'label' => 'Auxílio/Salário-Maternidade'],
    ['value' => 'previdenciario', 'label' => 'Previdenciário (geral)'],
    ['value' => 'imobiliaria', 'label' => 'Imobiliária'],
    ['value' => 'clinica', 'label' => 'Clínica / Saúde'],
    ['value' => 'outro', 'label' => 'Outro'],
];
