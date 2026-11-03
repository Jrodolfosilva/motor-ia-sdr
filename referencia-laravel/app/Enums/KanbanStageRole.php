<?php

namespace App\Enums;

/**
 * The 4 kanban stages with real business logic tied to their identity
 * (see KanbanStage model / KanbanController / WebhookHandler). Every other
 * stage is a tenant's free-form column with no role and no special
 * behavior - name/color/position only.
 */
enum KanbanStageRole: string
{
    case Onboarding = 'onboarding';
    case InProgress = 'in_progress';
    case Won = 'won';
    case Lost = 'lost';
}
