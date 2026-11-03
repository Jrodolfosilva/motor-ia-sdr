# 07. Saídas: handoff, desqualificação, follow-up

## handoff_reason (enum)
`classified` · `disqualified` · `media_received` · `handoff_keyword` · `max_turns_exceeded` · `turn_failed` · `followup_exhausted`

## HANDOFF(reason, classification?, summary?, confidence?)
1. Conversa → `status = handed_off`, `classification`, `handoff_reason`, `completed_at`.
2. Contato → etapa **"Em andamento"** do kanban (papel InProgress), no fim da coluna (`max(position)+1`).
3. Nota no contato: `[Onboarding IA] {summary || "Onboarding IA encerrado ({reason})."}{ (certeza da IA: X)}`.
4. Se a label tem `chat_label_id` → adiciona etiqueta no chat.
5. Se há `handoff_message` → envia com `{atendente}` = primeiro nome do responsável do contato (fallback "nossa equipe"), depois envia mídias `send_on_handoff`.
6. Posta o **card de resumo** (HandoffBriefing) como `internal_note` no chat. Nunca vai pro lead, nunca entra no histórico da IA.

## DISQUALIFY(label, summary?, confidence?)
Igual ao handoff, mas:
- etapa → **"Perdido"** (papel Lost), com `lost_reason_id = label.lost_reason_id`, `lost_at = now`
- mensagem = `label.disqualify_message ?? agent.disqualify_message`
- `handoff_reason = disqualified`

## Card de resumo (HandoffBriefing)
```
📋 Resumo da IA para a equipe
Motivo: {texto do reason}
Classificação: {label} (certeza: X)
{summary}

Dados coletados:
• {label curto}: {valor}{ (há N meses) se valor É uma data}
Faltou perguntar:
{labels faltantes}
Arquivos lidos pela IA:
• {nome do tipo}: {resumo}   (últimos 10)
Outros dados do formulário:
• {chave}: {valor}
```
"label curto" = label antes de ` (`. Textos de motivo:
- classified: Roteiro completo, classificada pela IA
- disqualified: Desqualificada pela IA
- media_received: Lead mandou um arquivo que a IA não conseguiu ler
- handoff_keyword: Lead pediu para falar com uma pessoa
- max_turns_exceeded: Conversa passou do limite de mensagens da IA
- turn_failed: Falha técnica da IA, assuma a conversa

## Humano assume manualmente
Se alguém arrasta o card para fora do Onboarding: `closeAbandoned(contact)` marca as conversas `active` como `handed_off` **sem** mexer em etapa e **sem** mandar mensagem. Sem isso a conversa ficava "active" para sempre e o follow-up disparava em cima do atendente.

Se arrastar **de volta** para Onboarding: o próximo turno reseta a conversa (ver doc 02, passo 2).

## Follow-up por inatividade (sweep, cron a cada minuto)
Para cada conversa `active` com `last_inbound_at` e agente ativo:
1. Pega a última mensagem do chat (ignorando `internal_note, reaction, sticker`).
2. **Se a última é do lead (inbound):** ele não sumiu. Mas se ela é mais nova que `last_inbound_at` e já passou `debounce + 120s` → o turno **se perdeu** (worker reiniciou) → reagenda o debounce. Return.
3. Steps ativos ordenados. `elapsed = minutos desde last_inbound_at`.
4. Para cada step com `step > followup_step_sent` e `elapsed >= delay_minutes`:
   - **claim atômico**: `UPDATE ... SET followup_step_sent = step WHERE id=? AND status='active' AND followup_step_sent = anterior`. 0 linhas → return (corrida com resposta do lead).
   - envia `step.message` (sem mudar status nem etapa).
5. Último step já enviado e `elapsed >= último delay + (followup_final_wait_minutes ?? 60)` → claim atômico `status active→handing_off` → `giveUpFollowUp`: status `handed_off`, reason `followup_exhausted`, etapa Perdido com `followup_lost_reason_id`, nota "sem resposta após follow-ups", **sem mensagem**.

Qualquer resposta do lead zera `followup_step_sent` (passo 2 do turno).

> Decisões do produto já tomadas, não reabrir: **sem horário comercial** (IA responde 24/7); **sem reativação em massa** de leads antigos; **follow-up gerado por IA fica fora do hub** (só os steps fixos).
