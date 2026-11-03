<?php

namespace App\Enums;

enum AiAgentRole: string
{
    case Sdr = 'sdr';
    case DocumentConcierge = 'document_concierge';
    case Closing = 'closing';

    public function label(): string
    {
        return match ($this) {
            self::Sdr => 'SDR / Recepção',
            self::DocumentConcierge => 'Concierge de Documentos',
            self::Closing => 'Fechamento & Onboarding',
        };
    }

    /**
     * Only this role has a wired runtime today (AiOnboardingAgentRunner) -
     * the other two are reserved kit slots, shown as "em breve" in the
     * wizard until their own runner exists.
     */
    public function isImplemented(): bool
    {
        return $this === self::Sdr;
    }
}
