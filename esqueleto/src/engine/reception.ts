// Recepção: as primeiras mensagens do atendimento, fixas (não geradas pela IA).
// Dois cenários:
//   - volume (lead frio): apresentação + "vou te fazer umas perguntas" → espera o lead
//   - form   (lead de formulário/pré-qualificado): apresentação + transição → IA segue na hora
//            confirmando os dados e pedindo os documentos
// Cada mensagem pode ser texto, áudio ou vídeo (gravados pela equipe).
import type { Agent, ReceptionMessage, ReceptionScenario, TurnContext } from './types';
import { inState, stateFor } from './rules/misc';
import { sendBubbles } from './runTurn';

export type ReceptionCase = 'volume' | 'form';

export const hasContent = (m: ReceptionMessage) =>
  m.enabled !== false && (m.kind === 'text' ? !!m.text?.trim() : !!m.media?.path);

/** Cenário de recepção do agente (com compatibilidade para greeting_example/consent_message). */
export function receptionFor(agent: Agent, which: ReceptionCase): ReceptionScenario {
  const r = agent.reception;
  if (r) {
    const sc = r[which];
    return { after: sc?.after ?? (which === 'volume' ? 'wait' : 'continue'), messages: (sc?.messages ?? []).filter((m) => m && hasContent(m)) };
  }
  // formato antigo: saudação nos dois; consentimento só no lead frio (e aí espera)
  const greet: ReceptionMessage[] = agent.greeting_example ? [{ kind: 'text', text: agent.greeting_example }] : [];
  if (which === 'volume' && agent.consent_message) {
    return { after: 'wait', messages: [...greet, { kind: 'text', text: agent.consent_message }] };
  }
  return { after: 'continue', messages: greet };
}

/** Acrescentar a presença no estado do DDD à 1ª mensagem de texto? */
const appendPresence = (agent: Agent) => agent.reception ? agent.reception.append_state_presence !== false : true;

/** Como a mensagem aparece para a IA (histórico/prompt). */
export function receptionLine(m: ReceptionMessage): string {
  if (m.kind === 'text') return m.text ?? '';
  const what = m.kind === 'audio' ? 'Áudio' : 'Vídeo';
  return `[${what} gravado pela atendente${m.transcript?.trim() ? `: "${m.transcript.trim()}"` : ''}]`;
}

const RECORDING_PAUSE_MS = 3000;

/** Envia a recepção do cenário. Texto vai com "digitando…"; áudio/vídeo com "gravando…". */
export async function sendReception(ctx: TurnContext, scenario: ReceptionScenario, phone: string | null): Promise<void> {
  const { agent, channel } = ctx;
  let firstText = true;
  for (const [i, m] of scenario.messages.entries()) {
    if (m.kind === 'text') {
      let text = m.text!.trim();
      const st = phone ? stateFor(phone) : null;
      if (firstText && i === 0 && st && appendPresence(agent)) text += ` Atendemos em todo o Brasil, com forte presença ${inState(st)}.`;
      firstText = false;
      await sendBubbles(ctx, [text], null);
      continue;
    }
    if (ctx.pacing) {
      await channel.setTyping?.(true, m.kind === 'audio' ? 'recording' : 'typing');
      await ctx.pacing.sleep(RECORDING_PAUSE_MS);
    }
    await channel.sendMedia({
      id: `reception-${i}`,
      type: m.kind,
      path: m.media!.path,
      mime: m.media!.mime,
      file_name: m.media!.file_name,
      caption: m.kind === 'video' ? m.caption ?? undefined : undefined,
      transcript: m.transcript ?? null,
    });
    if (ctx.pacing) await channel.setTyping?.(false);
  }
}

// ---------------------------------------------------------------------------
// Módulo de EXPLICAÇÃO: mensagens fixas entre as perguntas e o pedido de documentos
// (como o benefício funciona, valores, por que precisamos dos documentos). Envia uma vez.
// ---------------------------------------------------------------------------

/**
 * off = módulo desligado (a IA explica sozinha); pending = ainda não disparou;
 * inline / inline_wait = sai NESTE turno, no meio da resposta da IA (wait = depois dela, a IA espera o lead);
 * just_sent = (legado) acabou de sair antes da resposta; sent = já saiu em turno anterior.
 */
export type ExplanationState = 'off' | 'pending' | 'inline' | 'inline_wait' | 'just_sent' | 'sent';

/** Separador entre "antes da explicação" e "depois da explicação" na resposta da IA. */
export const EXPLANATION_MARK = '[[EXPLICACAO]]';

/** Divide a resposta em reação (antes) e continuação (depois). Sem marcador: tudo vai depois. */
export function splitAroundExplanation(text: string): { before: string; after: string } {
  const i = text.indexOf(EXPLANATION_MARK);
  if (i < 0) return { before: '', after: text.trim() };
  return { before: text.slice(0, i).trim(), after: text.slice(i + EXPLANATION_MARK.length).trim() };
}

export function explanationMessages(agent: Agent): ReceptionMessage[] {
  const ex = agent.explanation;
  return ex?.enabled ? ex.messages.filter((m) => m && hasContent(m)) : [];
}

/** Perguntas que precisam estar resolvidas para a explicação disparar. */
export function explanationTriggerKeys(agent: Agent): string[] {
  const keys = agent.explanation?.trigger_fields?.filter(Boolean) ?? [];
  return keys.length ? keys : agent.required_fields.map((f) => f.key);
}

/**
 * Pronto quando todas as perguntas-gatilho estão firmes (ou liberadas como pendência) E pelo menos
 * uma tem resposta de verdade: só pendência (lead recusou/enrolou tudo) não explica nem qualifica.
 */
export function explanationReady(
  agent: Agent,
  status: { isSettled(k: string): boolean; isPendingResolved(k: string): boolean },
): boolean {
  const keys = explanationTriggerKeys(agent);
  if (!keys.length) return true;
  return keys.every((k) => status.isSettled(k) || status.isPendingResolved(k)) && keys.some((k) => status.isSettled(k));
}
