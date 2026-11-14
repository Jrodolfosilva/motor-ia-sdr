// FAQ com respostas prontas em vários formatos (texto fixo, áudio ou vídeo gravado pela equipe).
// A cada conversa o motor escolhe, para cada pergunta, qual formato sai na próxima vez, variando:
// evita repetir o formato da última resposta de FAQ (ex: áudio, depois vídeo, depois texto) e não
// manda o mesmo arquivo duas vezes. A IA só decide QUANDO responder (função responder_faq).
import { sendReception } from './reception';
import type { FaqEntry, ReceptionMessage, TurnContext } from './types';

export interface FaqPick { variant: number; msg: ReceptionMessage }

/** Formatos prontos e utilizáveis da pergunta (texto com conteúdo ou arquivo enviado). */
export function faqReplies(f: FaqEntry): { variant: number; msg: ReceptionMessage }[] {
  return (f.replies ?? [])
    .map((msg, variant) => ({ variant, msg }))
    .filter(({ msg }) => msg.enabled !== false && (msg.kind === 'text' ? !!msg.text?.trim() : !!msg.media?.path));
}

/** Próximo formato de cada pergunta nesta conversa (só perguntas com resposta pronta ainda não usada). */
export function nextFaqReplies(
  faq: FaqEntry[], state: { faqSent?: string[]; faqLastKind?: string | null },
): Record<number, FaqPick> {
  const sent = new Set(state.faqSent ?? []);
  const out: Record<number, FaqPick> = {};
  faq.forEach((f, i) => {
    const fresh = faqReplies(f).filter((r) => !sent.has(`${i}:${r.variant}`));
    if (!fresh.length) return;
    // varia o formato: primeiro um diferente do último usado; depois o que vier
    out[i] = fresh.find((r) => r.msg.kind !== state.faqLastKind) ?? fresh[0];
  });
  return out;
}

/** Como o formato aparece para a IA no prompt. */
export function faqPickLine(p: FaqPick): string {
  const m = p.msg;
  if (m.kind === 'text') return `sai este TEXTO pronto: "${m.text!.trim()}". Não escreva a resposta você mesma: deixe sua mensagem vazia ou só reaja em poucas palavras ao que ela disse.`;
  const what = m.kind === 'audio' ? 'um ÁUDIO gravado pela equipe' : 'um VÍDEO gravado pela equipe';
  const says = m.transcript?.trim() ? ` (ele diz: "${m.transcript.trim()}")` : '';
  return `sai ${what}${says}. Não repita o conteúdo: escreva no máximo 1 frase curta de transição combinando com o formato (ex: "Vou te mandar ${m.kind === 'audio' ? 'um áudio' : 'um vídeo'} explicando certinho 😊") ou nada.`;
}

/** Envia a resposta pronta escolhida e registra (formato usado e arquivo já enviado). */
export async function sendFaqReply(ctx: TurnContext, faqIndex: number, pick: FaqPick): Promise<void> {
  const state = await ctx.store.loadState();
  await sendReception(ctx, { messages: [{ ...pick.msg, enabled: true }], after: 'wait' }, null);
  await ctx.store.saveState({
    faqSent: [...new Set([...(state.faqSent ?? []), `${faqIndex}:${pick.variant}`])],
    faqLastKind: pick.msg.kind,
  });
}
