# 02. Fluxo do turno (passo a passo)

Referência: `referencia-laravel/app/Services/WhatsApp/...` (gatilho, ver trecho abaixo), `AiOnboardingAgentRunner::run()`, `AiPlaygroundRunner::handle()/runTurn()`.

## Etapa A: chegada da mensagem (síncrono, no webhook)

Equivalente a `WebhookHandler::maybeRunAiOnboardingAgent()`. Ordem exata:

1. **Gate de elegibilidade.** Só segue se:
   - existe conexão/canal,
   - `contact.automation_paused == false`,
   - contato está **na etapa de Onboarding** do kanban,
   - existe agente `is_active` para essa conexão com `trigger_stage_id == etapa onboarding`.
2. **Persistir a mensagem** (já foi feito antes pelo webhook). O motor **nunca bufferiza conteúdo**: sempre relê o histórico do banco.
3. **Áudio:** tenta transcrever (Groq Whisper `whisper-large-v3-turbo`). Sucesso: grava `transcript` na própria mensagem, registra custo (por segundo de áudio) e passa a tratar como `text`.
4. **Imagem / PDF** legível (há modelo de visão e o arquivo é imagem ou `.pdf`): agenda o turno (debounce) e **retorna**. A leitura acontece dentro do job.
5. **Sticker:** ignora (não agenda turno, não faz handoff).
6. **Vídeo:** agenda turno. No histórico vira uma linha dizendo "não consigo assistir, peça print/foto".
7. **Qualquer outra mídia** (doc não-PDF, áudio que falhou): **handoff** com `reason = media_received`.
8. **Texto vazio:** ignora.
9. **Keywords de handoff** (`mb_stripos`, case-insensitive, substring): **handoff** `handoff_keyword`.
10. **Debounce:** `schedule(agent, contact)`.

## Etapa B: debounce

`AiOnboardingAgentDebouncer`:
```
token = uuid()
cache.set(`ai_turn:${agentId}:${contactId}`, token, ttl = debounce_seconds + 30)
queue.dispatch(RunTurnJob(agentId, contactId, token), delay = debounce_seconds)

// no job:
if (cache.get(key) !== token) return   // chegou msg nova depois, outro job vai rodar
runner.run(agent, contact)
```
No Express: **BullMQ** (Redis) com `delay`, ou para a Fase 1 um `setTimeout` em memória por chave. No simulador o debounce pode ser **zero** (responde na hora) ou configurável para testar rajadas.

## Etapa C: o turno (`run`)

```
1. RE-CHECK: contato ainda na etapa Onboarding e não pausado? senão return.
   (pode ter sido movido por humano entre msg e job)

2. CONVERSA: firstOrNew(agent, contact)
   - nova: status=active, started_at=now
   - existe mas status != active (humano arrastou de volta pro Onboarding):
       RESET → status=active, turns_count=0, opening_completed=false,
               classification=null, sent_media_ids=null, completed_at=null
   turns_count++, last_inbound_at=now, followup_step_sent=0  ← lead respondeu, zera follow-up

3. turns_count > max_turns → HANDOFF('max_turns_exceeded'); return

4. PRIMEIRO TURNO (turns_count == 1) e há greeting_example:
     greeting = greeting_example
     se DDD do telefone → estado: += " Atendemos em todo o Brasil, com forte presença {em SP/no RJ/na BA}."
     envia greeting (mensagem própria)
     lead FRIO (sem nenhum dado do roteiro nem de formulário) e há consent_message:
         envia consent_message; return   ← IA NÃO fala neste turno, espera o lead responder

5. MÍDIA PENDENTE: para cada imagem/PDF inbound sem ai_analysis (últimas 40):
     analysis = mediaAnalyzer.analyze(...)
     grava ai_analysis = analysis ?? {failed:true}   ← nunca cobra 2x o mesmo arquivo
     tipo ∈ {ultrassom, cartao_gestante, teste_gravidez, certidao_nascimento} → reage ❤️
   alguma falhou → HANDOFF('media_received'); return

6. HISTÓRICO = últimas 40 msgs úteis (ver "buildHistory" abaixo)
   remove mensagens assistant do FINAL do histórico (crítico, ver lições)
   vazio → return
   lastSeenInboundId = id da última inbound (text/audio/image/document/video)

7. isFirstResponderTurn = !opening_completed; opening_completed = true

8. try {
     known = contact.custom_fields
     collected = EXTRACTOR(history, known)
     collected = map(DurationNormalizer.normalize)   // "oito meses" → "8 meses"
     known = {...known, ...collected}; salva no contato

     decision = QUALIFIER(history, known)
     if decision.classification:
        label = labels.find(key)
        isDisqualify = label.outcome == 'disqualify'
        if isDisqualify && label.rules && !rulesMatch(label.rules, known):
            log "disqualify rejeitado por regra" → segue pro responder (conversa continua)
        else:
            conversation.classification = key
            isDisqualify ? DISQUALIFY(label, summary, confidence)
                         : HANDOFF('classified', key, summary, confidence)
            return

     reply = RESPONDER(history, known, isFirstResponderTurn, phone, sent_media_ids)
     requestedMedia = responder.lastRequestedMedia
     reply == '' && requestedMedia == [] → throw "empty reply"
   } catch {
     log; envia fallback_message (se houver); return
   }

9. BALÕES: splitIntoBubbles(reply) → até 3
   para cada balão:
     if lastInboundId() != lastSeenInboundId: return   ← lead escreveu no meio, outro turno já vem
     sendReply(balão)  (com "digitando" proporcional ao tamanho)

10. sendLibraryMedia(requestedMedia)  (não reenviar ids já em sent_media_ids)
```

### buildHistory
Lê as últimas 40 mensagens (ordenar por **id**, não por timestamp; várias msgs no mesmo segundo embaralham a ordem) e converte:

| Mensagem | Vira |
|---|---|
| `text` | `body` |
| áudio com `transcript` | `transcript` |
| imagem/PDF com `ai_analysis` ok | `MediaAnalyzer.historyLine()` → `"[Imagem enviado pela lead - ctps: ... Dados lidos: ... ]"` |
| imagem/PDF com `ai_analysis.failed` | **excluída** |
| vídeo inbound | `VIDEO_HISTORY_LINE` |
| sticker, reaction, internal_note, áudio sem transcrição | **excluída** |

`role = outbound ? 'assistant' : 'user'`.

## Variante simulador (Fase 1)

`AiPlaygroundRunner` faz **o mesmo fluxo** com estas diferenças:
- Estado vive numa `session` (JSON de `messages`, `custom_fields`, `status`, `turns_count`, `opening_completed`, `classification`, `sent_media_ids`, `phone` fake).
- Etapa A roda inline (sem debounce).
- Se `session.status != active`: adiciona evento "conversa encerrada, clique reiniciar".
- Handoff/disqualify viram **eventos** na timeline (`role: 'event'`, `type: handoff|disqualify|info`) em vez de mover kanban.
- `{atendente}` vira "nossa equipe".
- Erro do provider aparece como evento visível + fallback.
- Botão **Reiniciar** = apagar a sessão.

No projeto novo isso não é outro runner: é o mesmo `runTurn` com `SimulatorChannel` + `SessionStore` + `EventPipeline`.
