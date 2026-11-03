// Orquestrador único. Mesmo código para simulador (Fase 1) e WhatsApp (Fase 2):
// só mudam os adapters em TurnContext. Ver docs/02-fluxo-do-turno.md.
import type {
  ChatMessage, ClassificationLabel, HandoffReason, MediaAnalysis, ReceptionMessage, StoredMessage, TurnContext,
} from './types';
import { filled, PENDING_LABEL, RequiredFieldsStatus } from './rules/requiredFields';
import { rulesMatch } from './rules/classificationRules';
import { normalizeDuration } from './rules/duration';
import { DEFAULT_BUBBLE_DELAY, inState, splitIntoBubbles, stateFor, typingDelaySeconds } from './rules/misc';
import { extract } from './agents/extractor';
import { decide } from './agents/qualifier';
import { reply } from './agents/responder';
import { mediaNotices, newInbound, repliesToUnreadable } from './guardrails';
import { classificationEvent, fireCrm } from './crm';
import {
  explanationMessages, explanationReady, receptionFor, sendReception, splitAroundExplanation, type ExplanationState,
} from './reception';

const HISTORY_LIMIT = 40;
const DEFAULT_REACT_TYPES = ['ultrassom', 'cartao_gestante', 'teste_gravidez', 'certidao_nascimento'];

export const VIDEO_HISTORY_LINE = '[Vídeo enviado pela lead - você não assiste vídeos]';
export const AUDIO_FAIL_LINE = '[Áudio enviado pela lead que não deu para entender]';
export const FILE_FAIL_LINE = '[Arquivo enviado pela lead que não deu para abrir/ler]';

// ---------------------------------------------------------------------------
// ETAPA A: intake (chamado quando a mensagem chega, antes do debounce)
// ---------------------------------------------------------------------------

export type IntakeResult = 'schedule' | 'ignore' | 'handed_off';

/**
 * `transcribe` já deve ter sido tentado para áudio (grave `transcript` na mensagem antes).
 * Retorna 'schedule' quando o chamador deve agendar o turno (debounce).
 */
export async function intake(ctx: TurnContext, msg: StoredMessage, hasVision: boolean): Promise<IntakeResult> {
  if (!(await ctx.pipeline.isInOnboarding())) return 'ignore';

  const type = msg.type === 'audio' && msg.transcript ? 'text' : msg.type;

  if ((type === 'image' || type === 'document') && hasVision && ctx.media.supports(msg)) return 'schedule';
  // arquivo já lido (ex: documento simulado no simulador) → segue o turno normal
  if ((type === 'image' || type === 'document') && msg.aiAnalysis && !('failed' in msg.aiAnalysis)) return 'schedule';
  if (type === 'sticker' || type === 'reaction') return 'ignore';
  if (type === 'video') return 'schedule';
  // áudio que não deu pra transcrever / arquivo que não dá pra ler: aviso fixo e segue o fluxo (se configurado)
  if (type === 'audio' && repliesToUnreadable(ctx.agent, 'audio')) return 'schedule';
  if ((type === 'image' || type === 'document') && repliesToUnreadable(ctx.agent, 'file')) return 'schedule';
  if (type !== 'text') {
    await handOff(ctx, 'media_received');
    return 'handed_off';
  }

  const text = (msg.transcript ?? msg.body).trim();
  if (!text) return 'ignore';

  const lower = text.toLocaleLowerCase('pt-BR');
  if (ctx.agent.handoff_keywords.some((k) => k.trim() && lower.includes(k.trim().toLocaleLowerCase('pt-BR')))) {
    await handOff(ctx, 'handoff_keyword');
    return 'handed_off';
  }

  return 'schedule';
}

// ---------------------------------------------------------------------------
// ETAPA C: turno
// ---------------------------------------------------------------------------

export async function runTurn(ctx: TurnContext): Promise<void> {
  const { agent, store, channel, pipeline, llm } = ctx;

  if (!(await pipeline.isInOnboarding())) return;

  // 2. estado da conversa
  let state = await store.loadState();
  if (!state.isNew && state.status !== 'active') {
    // humano devolveu o card para Onboarding → nova rodada
    await store.saveState({
      status: 'active', turnsCount: 0, openingCompleted: false,
      classification: null, sentMediaIds: [], handoffReason: null,
    });
    state = await store.loadState();
  }
  const turnsCount = state.turnsCount + 1;
  await store.saveState({ status: 'active', turnsCount, lastInboundAt: ctx.now ?? new Date(), followupStepSent: 0 });

  // 3. limite de turnos
  if (turnsCount > agent.max_turns) return handOff(ctx, 'max_turns_exceeded');

  const contact = await store.contact();
  let known = await store.getKnownFields();

  // 3b. fixa o que veio do formulário (Meta/LP): essas perguntas precisam ser confirmadas pelo lead
  let formKeys = state.formKeys ?? new RequiredFieldsStatus(agent.required_fields, known).filledQuestionKeys();
  let confirmedKeys = state.confirmedKeys ?? [];
  let pending = state.pending ?? {};
  if (state.formKeys == null) await store.saveState({ formKeys, confirmedKeys, pending });
  const progress = () => ({ formKeys, confirmedKeys, pending });

  // 4. ler imagens/PDF pendentes ANTES da recepção: se o lead abriu a conversa mandando um
  //    arquivo e a recepção "espera o lead", o arquivo já fica lido para o próximo turno
  const mediaOk = await analyzePendingMedia(ctx);
  // avisos fixos (vídeo, áudio/arquivo que não deu pra usar) para as mensagens novas - calculado
  // antes da recepção, porque depois dela a "última fala do atendimento" muda
  const fresh = newInbound(await store.recentMessages(HISTORY_LIMIT));
  const notices = mediaNotices(agent, fresh);
  // a lead só mandou mídia que não dá pra usar (nada de texto/áudio/arquivo legível junto)?
  const onlyUnusable = notices.length > 0 && fresh.every((m) =>
    m.type === 'video' || (m.type === 'audio' && !m.transcript)
    || ((m.type === 'image' || m.type === 'document') && (!m.aiAnalysis || 'failed' in m.aiAnalysis)));

  // 5. recepção por cenário (texto/áudio/vídeo fixos; sempre sai inteira, sem abortar)
  if (turnsCount === 1) {
    await fireCrm(ctx, 'atendimento_iniciado');
    const isCold = !new RequiredFieldsStatus(agent.required_fields, known, agent.required_documents).hasAnyKnownData();
    const scenario = receptionFor(agent, isCold ? 'volume' : 'form');
    if (scenario.messages.length) {
      await sendReception(ctx, scenario, contact.phone);
      if (scenario.after === 'wait' && mediaOk) return; // IA só fala quando o lead responder
    }
  }

  if (!mediaOk && !repliesToUnreadable(agent, 'file')) return handOff(ctx, 'media_received');
  if (notices.length) await sendBubbles(ctx, notices, null);

  // 6. histórico
  const messages = await store.recentMessages(HISTORY_LIMIT);
  const history = buildHistory(messages);
  while (history.length && history[history.length - 1].role === 'assistant') history.pop();
  if (history.length === 0) return;

  const lastSeenInboundId = await store.lastInboundId();
  const userMessage = [...history].reverse().find((m) => m.role === 'user')?.content as string | undefined;

  // 7.
  // "digitando…" enquanto a IA pensa (desliga ao fim dos balões ou se o turno sair antes)
  if (ctx.pacing) await channel.setTyping?.(true);

  const isFirstResponderTurn = !state.openingCompleted;
  await store.saveState({ openingCompleted: true });

  // 8. extractor → qualifier → responder
  let text: string;
  let requestedMedia: string[];
  let inlineExplanation: ReceptionMessage[] | null = null;
  try {
    const ex = await extract(llm, agent, history, known, progress(), ctx.now);
    if (ex.log) await ctx.usage.record(ex.log, userMessage ?? null);

    if (Object.keys(ex.collected).length) {
      const normalized = Object.fromEntries(
        Object.entries(ex.collected).map(([k, v]) => [k, typeof v === 'string' ? normalizeDuration(v) : v]),
      );
      known = { ...known, ...normalized };
      await store.saveKnownFields(known);
    }

    // origem dos dados: formulário → precisa confirmar; dito na conversa ou lido em documento → confirmado
    const questionKeys = new Set(agent.required_fields.map((f) => f.key));
    const nextForm = new Set(formKeys);
    const nextConfirmed = new Set([...confirmedKeys, ...ex.confirmed.filter((k) => nextForm.has(k))]);
    for (const [k, src] of Object.entries(ex.sources)) {
      if (!questionKeys.has(k)) continue;
      if (src === 'formulario') nextForm.add(k);
      else if (nextForm.has(k)) nextConfirmed.add(k);
    }
    if (nextForm.size !== formKeys.length || nextConfirmed.size !== confirmedKeys.length) {
      formKeys = [...nextForm];
      confirmedKeys = [...nextConfirmed];
      await store.saveState({ formKeys, confirmedKeys });
    }

    // pendências: "depois" / "não tem" / "recusou" (mesma resposta de novo soma +1)
    const nextPending = { ...pending };
    for (const k of Object.keys(ex.collected)) delete nextPending[k];
    for (const [k, p] of Object.entries(ex.pending)) {
      const prev = nextPending[k];
      nextPending[k] = { status: p.status, detail: p.detail ?? prev?.detail ?? null, count: (prev?.count ?? 0) + 1 };
    }
    if (JSON.stringify(nextPending) !== JSON.stringify(pending)) {
      pending = nextPending;
      await store.saveState({ pending });
    }

    // marcos do roteiro → CRM (cada um uma vez por conversa)
    const done = new RequiredFieldsStatus(agent.required_fields, known, agent.required_documents, progress());
    if (agent.required_fields.length && explanationReady(agent, done)) await fireCrm(ctx, 'perguntas_completas');
    for (const d of agent.required_documents) if (filled(known[d.key])) await fireCrm(ctx, `documento_recebido:${d.key}`, d.label);
    if (agent.required_documents.length && agent.required_documents.every((d) => filled(known[d.key]))) await fireCrm(ctx, 'documentos_completos');
    for (const k of Object.keys(ex.pending)) await fireCrm(ctx, `pendencia_registrada:${k}`);

    const q = await decide(llm, agent, history, known, ctx.now, progress());
    if (q.log) await ctx.usage.record(q.log, userMessage ?? null);

    if (q.decision.classification) {
      const label = agent.classification_labels.find((l) => l.key === q.decision.classification);
      const isDisqualify = label?.outcome === 'disqualify';
      const rejectedByRule = isDisqualify && !!label?.rules?.length && !rulesMatch(label.rules, known, ctx.now);

      if (rejectedByRule) {
        await pipeline.emitEvent({ kind: 'info', message: `Desqualificação "${label!.key}" rejeitada: perfil não satisfaz as regras da label.` });
      } else {
        await store.saveState({ classification: q.decision.classification });
        if (isDisqualify && label) return disqualify(ctx, label, q.decision.summary, q.decision.confidence);
        return handOff(ctx, 'classified', q.decision.classification, q.decision.summary, q.decision.confidence);
      }
    }

    // 8b. módulo de EXPLICAÇÃO (fixo, uma vez): quando as perguntas-gatilho fecham, explica o
    //     benefício antes de pedir documentos. Depois: IA pede o 1º documento ou espera o lead.
    //     A explicação sai NO MEIO da resposta da IA: [reação ao que ela disse] → explicação → [pedido do documento].
    //     Uma chamada só: o responder escreve as duas partes separadas por EXPLANATION_MARK.
    let explanation: ExplanationState = 'off';
    const exMsgs = explanationMessages(agent);
    if (exMsgs.length) {
      const now = await store.loadState();
      if (now.explanationSent) explanation = 'sent';
      else if (explanationReady(agent, new RequiredFieldsStatus(agent.required_fields, known, agent.required_documents, progress()))) {
        explanation = agent.explanation!.after === 'wait' ? 'inline_wait' : 'inline';
      } else explanation = 'pending';
    }
    inlineExplanation = explanation === 'inline' || explanation === 'inline_wait' ? exMsgs : null;

    const sent = (await store.loadState()).sentMediaIds;
    const r = await reply(llm, agent, history, known, isFirstResponderTurn, contact.phone, sent, ctx.now, progress(), explanation, notices, onlyUnusable);
    await ctx.usage.record(r.log, userMessage ?? null);
    text = r.text;
    requestedMedia = r.requestedMedia;

    if (text === '' && requestedMedia.length === 0 && !inlineExplanation) throw new Error('Responder returned an empty reply');
  } catch (err) {
    await pipeline.emitEvent({ kind: 'info', message: `Falha ao chamar o provedor de IA: ${(err as Error).message.slice(0, 300)}` });
    if (agent.fallback_message) await sendBubbles(ctx, [agent.fallback_message], null);
    else if (ctx.pacing) await channel.setTyping?.(false);
    return;
  }

  // 9. balões com "digitando…" e pausa; se o lead escrever no meio, o resto é descartado
  //    (a próxima resposta é gerada de novo já com a mensagem nova)
  if (inlineExplanation) {
    const { before, after } = splitAroundExplanation(text);
    if (!(await sendBubbles(ctx, splitIntoBubbles(before), lastSeenInboundId))) return; // explicação fica para o próximo turno
    await sendReception(ctx, { messages: inlineExplanation, after: agent.explanation!.after }, null);
    await store.saveState({ explanationSent: true });
    await fireCrm(ctx, 'explicacao_enviada');
    if (agent.explanation!.after === 'wait') return;
    if (!(await sendBubbles(ctx, splitIntoBubbles(after), lastSeenInboundId))) return;
  } else if (!(await sendBubbles(ctx, splitIntoBubbles(text), lastSeenInboundId))) return;

  // 10. mídia da biblioteca
  await sendLibraryMedia(ctx, requestedMedia);
}

/**
 * Envia balões um a um, com "digitando…" e pausa proporcional ao texto (agent.bubble_delay).
 * Com `abortIfInboundChangedFrom`, para assim que chegar mensagem nova do lead: o que ainda
 * não saiu provavelmente não faz mais sentido. Retorna false se interrompeu.
 */
export async function sendBubbles(ctx: TurnContext, bubbles: string[], abortIfInboundChangedFrom: string | null): Promise<boolean> {
  const { channel, store, pipeline, agent } = ctx;
  const cfg = agent.bubble_delay ?? DEFAULT_BUBBLE_DELAY;
  const interrupted = async () =>
    abortIfInboundChangedFrom !== null && (await store.lastInboundId()) !== abortIfInboundChangedFrom;
  try {
    for (let i = 0; i < bubbles.length; i++) {
      // checa antes de "digitar" (resposta já velha) e depois da pausa (lead escreveu durante)
      if (ctx.pacing && !(await interrupted())) {
        await channel.setTyping?.(true);
        await ctx.pacing.sleep(typingDelaySeconds(bubbles[i], cfg) * 1000);
      }
      if (await interrupted()) {
        const dropped = bubbles.length - i;
        await pipeline.emitEvent({
          kind: 'info',
          message: `Lead escreveu enquanto a IA respondia: ${dropped} ${dropped === 1 ? 'balão descartado' : 'balões descartados'}. Nova resposta vai considerar a mensagem nova.`,
        });
        return false;
      }
      await channel.sendText(bubbles[i]);
    }
    return true;
  } finally {
    if (ctx.pacing) await channel.setTyping?.(false);
  }
}

// ---------------------------------------------------------------------------
// Histórico e mídia
// ---------------------------------------------------------------------------

export function historyLine(msg: StoredMessage, a: MediaAnalysis): string {
  const kind = msg.type === 'image' ? 'Imagem' : 'PDF';
  let line = `[${kind} enviado pela lead - ${a.tipo ?? 'outro'}: ${String(a.resumo ?? '').trim()}.`;
  const fields = Object.entries(a.dados ?? {})
    .filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v) && String(v) !== '')
    .map(([k, v]) => `${k}: ${typeof v === 'boolean' ? (v ? 'sim' : 'não') : v}`);
  if (fields.length) line += ` Dados lidos: ${fields.join('; ')}.`;
  if (a.legivel === false) line += ' Arquivo pouco legível - peça para reenviar com mais nitidez.';
  const caption = msg.body.trim();
  if (caption && !/^\[[A-Za-z ]+\]$/.test(caption)) line += ` Legenda: "${caption}".`;
  return line + ']';
}

export function buildHistory(messages: StoredMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    let content: string | null = null;
    // áudio/vídeo que a atendente (recepção/biblioteca) enviou: a IA só conhece pela transcrição cadastrada
    if (m.direction === 'outbound' && (m.type === 'audio' || m.type === 'video')) {
      content = m.transcript ? `[${m.type === 'audio' ? 'Áudio' : 'Vídeo'} enviado pela atendente: "${m.transcript}"]` : null;
    } else if (m.transcript) content = m.transcript;
    else if (m.aiAnalysis && !('failed' in m.aiAnalysis)) content = historyLine(m, m.aiAnalysis);
    else if (m.type === 'text') content = m.body;
    else if (m.type === 'video' && m.direction === 'inbound') content = VIDEO_HISTORY_LINE;
    else if (m.type === 'audio' && m.direction === 'inbound') content = AUDIO_FAIL_LINE;
    else if ((m.type === 'image' || m.type === 'document') && m.direction === 'inbound') content = FILE_FAIL_LINE;
    if (content !== null) out.push({ role: m.direction === 'outbound' ? 'assistant' : 'user', content });
  }
  return out;
}

async function analyzePendingMedia(ctx: TurnContext): Promise<boolean> {
  const reactTypes = ctx.agent.kit.vision_context?.react_to_types ?? DEFAULT_REACT_TYPES;
  const pending = (await ctx.store.recentMessages(HISTORY_LIMIT)).filter(
    (m) => m.direction === 'inbound' && (m.type === 'image' || m.type === 'document') && !m.aiAnalysis && m.mediaPath && ctx.media.supports(m),
  );

  let allRead = true;
  for (const m of pending) {
    const result = await ctx.media.analyze(ctx.agent, m);
    const { log, ...analysis } = result ?? ({} as NonNullable<typeof result>);
    if (log) await ctx.usage.record(log, null); // custo da visão entra junto com os demais
    await ctx.store.updateMessage(m.id, { aiAnalysis: result ? analysis : { failed: true } }); // nunca cobrar 2x
    allRead &&= result !== null;
    if (result && reactTypes.includes(result.tipo)) {
      try { await ctx.channel.sendReaction(m, '❤️'); } catch { /* best-effort */ }
    }
  }
  return allRead;
}

async function sendLibraryMedia(ctx: TurnContext, ids: string[]): Promise<void> {
  const state = await ctx.store.loadState();
  const sent = new Set(state.sentMediaIds);
  for (const item of ctx.agent.kit.media_library) {
    if (!ids.includes(item.id) || sent.has(item.id)) continue;
    try {
      await ctx.channel.sendMedia(item);
      sent.add(item.id);
    } catch { /* pula item com erro */ }
  }
  await ctx.store.saveState({ sentMediaIds: [...sent] });
}

// ---------------------------------------------------------------------------
// Saídas (docs/07)
// ---------------------------------------------------------------------------

const withConfidence = (note: string, c?: string | null) => (c ? `${note} (certeza da IA: ${c})` : note);

export async function handOff(
  ctx: TurnContext, reason: HandoffReason,
  classification: string | null = null, summary: string | null = null, confidence: string | null = null,
): Promise<void> {
  const { agent, store, channel, pipeline } = ctx;
  const state = await store.loadState();
  await store.saveState({ status: 'handed_off', classification: classification ?? state.classification, handoffReason: reason });

  await pipeline.moveToHandoff(withConfidence(summary || `Onboarding IA encerrado (${reason}).`, confidence));
  const cls = classification ?? state.classification;
  if (reason === 'classified' && cls) await fireCrm(ctx, classificationEvent(cls), summary ?? '');
  else await fireCrm(ctx, 'passou_para_equipe', reason);

  const label = classification ? agent.classification_labels.find((l) => l.key === classification) : undefined;
  if (label?.chat_label_id) await pipeline.attachLabel(label.chat_label_id);

  if (agent.handoff_message) {
    const contact = await store.contact();
    const first = contact.assignedToName?.trim().split(' ')[0];
    await sendBubbles(ctx, [agent.handoff_message.replaceAll('{atendente}', first || 'nossa equipe')], null);
    await sendLibraryMedia(ctx, agent.kit.media_library.filter((m) => m.send_on_handoff).map((m) => m.id));
  }

  // TODO: montar card completo (docs/07 "Card de resumo") em briefing.ts
  await channel.postInternalNote(`📋 Resumo da IA para a equipe\nMotivo: ${reason}${summary ? `\n${summary}` : ''}${await pendingNote(ctx)}`);
  await pipeline.emitEvent({ kind: 'handoff', reason, classification, summary, confidence });
  if (ctx.pacing) await channel.setTyping?.(false);
}

export async function disqualify(
  ctx: TurnContext, label: ClassificationLabel, summary: string | null, confidence: string | null,
): Promise<void> {
  const { agent, store, channel, pipeline } = ctx;
  await store.saveState({ status: 'handed_off', classification: label.key, handoffReason: 'disqualified' });
  await pipeline.moveToLost(withConfidence(summary || `Onboarding IA: lead desqualificado (${label.label}).`, confidence), label.lost_reason_id);
  await fireCrm(ctx, classificationEvent(label.key), summary ?? '');
  if (label.chat_label_id) await pipeline.attachLabel(label.chat_label_id);

  const msg = label.disqualify_message ?? agent.disqualify_message;
  if (msg) await sendBubbles(ctx, [msg], null);

  await channel.postInternalNote(`📋 Resumo da IA para a equipe\nMotivo: Desqualificada pela IA\nClassificação: ${label.label}${summary ? `\n${summary}` : ''}${await pendingNote(ctx)}`);
  await pipeline.emitEvent({ kind: 'disqualify', classification: label.key, summary, confidence });
  if (ctx.pacing) await channel.setTyping?.(false);
}

/** Itens do roteiro que ficaram para a equipe cobrar (adiados, sem acesso, recusados). */
async function pendingNote(ctx: TurnContext): Promise<string> {
  const state = await ctx.store.loadState();
  const known = await ctx.store.getKnownFields();
  const status = new RequiredFieldsStatus(ctx.agent.required_fields, known, ctx.agent.required_documents, state);
  const items = [...ctx.agent.required_fields, ...ctx.agent.required_documents]
    .map((x) => ({ x, p: status.pendingFor(x.key) }))
    .filter((e) => e.p);
  if (!items.length) return '';
  return `\n\n⚠️ Pendências para a equipe:\n${items
    .map(({ x, p }) => `- ${x.label}: ${PENDING_LABEL[p!.status]}${p!.detail ? ` ("${p!.detail}")` : ''}`)
    .join('\n')}`;
}
