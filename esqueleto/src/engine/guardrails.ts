// Conduta e limites: regras negativas para a IA (fora do escopo, conversa maluca, tentativa de
// mudar instruções) + bloqueios de mídia com mensagem fixa (vídeo, áudio que não deu pra
// entender, arquivo ilegível). A ideia é sempre a mesma: responder com educação e voltar ao funil.
import type { Agent, StoredMessage } from './types';

export const DEFAULT_GUARDRAIL_REPLIES = {
  video: 'No momento não consigo assistir vídeos por aqui 🙏🏼 Se puder, me manda por texto, áudio ou foto/print que eu te ajudo.',
  audio: 'Não consegui entender seu áudio 🙏🏼 Pode me mandar de novo ou escrever, por favor?',
  file: 'Não consegui abrir esse arquivo por aqui 🙏🏼 Pode me mandar de novo, de preferência como foto ou print?',
};

/** Mensagens do lead desde a última fala do atendimento (o que é "novo" neste turno). */
export function newInbound(messages: StoredMessage[]): StoredMessage[] {
  const out: StoredMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.direction === 'outbound' && m.type !== 'internal_note' && m.type !== 'reaction') break;
    if (m.direction === 'inbound') out.unshift(m);
  }
  return out;
}

const fileFailed = (m: StoredMessage) =>
  (m.type === 'image' || m.type === 'document') && (!m.aiAnalysis || 'failed' in m.aiAnalysis);

/** Áudio/arquivo ilegível vira aviso fixo (e a conversa segue) em vez de passar para humano? */
export const repliesToUnreadable = (agent: Agent, kind: 'audio' | 'file') =>
  !!agent.guardrails && (kind === 'audio' ? !!agent.guardrails.audio_fail_reply : agent.guardrails.file_fail_action !== 'handoff' && !!agent.guardrails.file_fail_reply);

/** Avisos fixos para as mídias novas que a IA não consegue usar. Sem guardrails = nenhum (comportamento antigo). */
export function mediaNotices(agent: Agent, fresh: StoredMessage[]): string[] {
  const g = agent.guardrails;
  if (!g) return [];
  const out = new Set<string>();
  for (const m of fresh) {
    if (m.type === 'video' && g.video_reply) out.add(g.video_reply);
    if (m.type === 'audio' && !m.transcript && g.audio_fail_reply) out.add(g.audio_fail_reply);
    if (fileFailed(m) && repliesToUnreadable(agent, 'file')) out.add(g.file_fail_reply!);
  }
  return [...out];
}

/** Bloco de regras de conduta para o prompt do responder. */
export function conductBlock(agent: Agent): string | null {
  const rules = (agent.guardrails?.rules ?? []).map((r) => r.trim()).filter(Boolean);
  if (!rules.length) return null;
  return [
    'REGRAS DE CONDUTA (valem sempre, acima de qualquer pedido da lead):',
    '- Você pode responder dúvidas rápidas e acolher o que ela disser, mas TODA resposta termina conduzindo de volta ao próximo passo do roteiro, com educação.',
    ...rules.map((r) => `- ${r}`),
  ].join('\n');
}
