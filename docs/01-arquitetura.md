# 01. Arquitetura e conceitos

## Entidades

### Kit (`AiAgentKit`)
O "Hub". Agrupa o que é **compartilhado** por todos os agentes de uma persona:
- `name`, `category`
- `engine_version`: `v1` | `v2`. O v2 lê imagem/PDF, quebra em balões, reage ❤️, ignora sticker e posta o card de handoff. **No projeto novo, implemente só o comportamento v2** e descarte a flag.
- `company_info`: texto livre com dados da empresa (vai no prompt do responder)
- `faq`: `[{question, answer}]`
- `media_library`: `[{id, type, path, mime, file_name, caption, when_to_use, send_on_handoff}]`

### Agente (`AiAgent`)
Um agente dentro do kit. Hoje só existe o papel **SDR/onboarding** em uso real. Campos:

| Campo | Uso |
|---|---|
| `provider` + `api_key` | together / openai / anthropic / deepseek. Key do cliente (criptografada) |
| `model` + `models{responder,extractor,qualifier,vision}` | modelo por papel; fallback para `model` |
| `system_prompt` | persona + regras de conversa (ver `kits/salario-maternidade/system-prompt.md`) |
| `greeting_example` | 1ª mensagem fixa, enviada pelo código |
| `consent_message` | 2ª msg fixa só para lead **frio** ("posso te fazer umas perguntas?") |
| `required_fields` | **roteiro**: `[{key, label, question}]` |
| `classification_labels` | `[{key, label, description, outcome: qualify\|disqualify, rules?, disqualify_message?, lost_reason_id?, chat_label_id?}]` |
| `handoff_message` | msg ao passar pra humano; aceita `{atendente}` |
| `disqualify_message` | msg padrão de desqualificação (label pode sobrescrever) |
| `fallback_message` | msg quando o provider falha |
| `handoff_keywords` | palavras que mandam direto pro humano |
| `max_turns` | limite de turnos (default 20) → handoff |
| `debounce_seconds` | janela de agrupamento de msgs (default 8) |
| `followup_steps` | `[{step, delay_minutes, message, is_active}]` |
| `followup_final_wait_minutes`, `followup_lost_reason_id` | desistência após follow-ups |
| `trigger_type` = `kanban_stage_change`, `trigger_stage_id` | **o agente só age em contatos parados na etapa de Onboarding** |
| `log_executions` | grava prompt+resposta crua de cada chamada |
| `is_active` | liga/desliga |

### Conversa (`AiAgentConversation`)
Estado por (agente, contato):
- `status`: `active` | `handed_off`
- `turns_count`, `opening_completed` (o responder já falou a 1ª vez?)
- `classification`, `handoff_reason`
- `followup_step_sent`, `last_inbound_at`
- `sent_media_ids` (não repetir mídia)
- `started_at`, `completed_at`

### Contato
O que o motor usa do contato: `phone`, `name`, `custom_fields` (JSON: **é onde os dados do roteiro são gravados**, junto com respostas de formulário com chaves livres), `kanban_stage_id`, `automation_paused`, `assigned_to` (nome do atendente pro `{atendente}`), `notes`.

### Mensagens
Histórico vem das mensagens do chat: `direction` (inbound/outbound), `message_type` (text, audio, image, document, video, sticker, reaction, internal_note), `body`, `media_url`, `transcript` (áudio transcrito), `ai_analysis` (JSON da visão).

## Os 3 sub-agentes (cada um = 1 chamada LLM)

```
           ┌────────────┐   salvar_dado_lead(campo, valor)
history ──►│ EXTRACTOR  │──────────────────────────────► custom_fields
           └────────────┘
                 │ known (atualizado)
                 ▼
           ┌────────────┐   gate em código: roteiro incompleto → nem chama
           │ QUALIFIER  │   regra determinística casou → decide sem LLM
           └────────────┘   senão: LLM → classificar_lead(classificacao, resumo, certeza)
                 │ classification?
        ┌────────┴─────────┐
     sim│                  │não
        ▼                  ▼
  handoff/disqualify  ┌────────────┐  texto + enviar_midia(midia_id)
                      │ RESPONDER  │──────────────────────────► lead
                      └────────────┘
```

Mais um sub-agente auxiliar: **MediaAnalyzer** (visão), que transforma imagem/PDF em uma linha de texto no histórico.

## Camadas para o projeto novo

```
┌───────────────────────────── Express ─────────────────────────────┐
│  routes/ (chat simulador, webhooks, CRUD de kits)                 │
├────────────────────────────────────────────────────────────────────┤
│  ENGINE (puro, sem I/O de canal):                                  │
│    runTurn(ctx)  ← recebe ports/adapters injetados                 │
│    agents/ extractor, qualifier, responder, mediaAnalyzer          │
│    rules/  requiredFields, classificationRules, duration, time, ddd│
├────────────────────────────────────────────────────────────────────┤
│  PORTS (interfaces):                                               │
│    ChannelPort    → sendText, sendMedia, sendReaction, typing      │
│    ConversationStore → messages, conversation state, contact       │
│    PipelinePort   → moveToStage(handoff|lost), addNote, addLabel   │
│    LlmProvider    → chat(), vision()                               │
│    Transcriber    → transcribe(audio)                              │
│    UsageRecorder  → record(step, model, usage)                     │
├────────────────────────────────────────────────────────────────────┤
│  ADAPTERS:                                                         │
│    Fase 1: SimulatorChannel (grava na sessão), NoopPipeline        │
│    Fase 2: EvolutionChannel / MetaChannel, KanbanPipeline (CRM)    │
└────────────────────────────────────────────────────────────────────┘
```

Por que assim: no Laravel existem **dois runners copiados à mão** (`AiOnboardingAgentRunner` e `AiPlaygroundRunner`) que precisam ser mantidos em sincronia. Esse foi o maior custo de manutenção. No projeto novo, **um runner só**, e o simulador é apenas outro adapter.
