# 09. Plano do projeto Express

## Stack sugerida
- Node 22 + **TypeScript** + Express 5
- **MongoDB** + Mongoose (decisão 2026-11-02; substitui Postgres + Prisma)
- **Redis**: BullMQ para debounce/jobs, token "último ganha" do debounce, locks/claims do sweep. Na Fase 1, fila em memória serve.
- `openai` SDK (com `baseURL` para Together/DeepSeek) + `@anthropic-ai/sdk`
- `zod` para validar kit/agent e args de tool call
- Vitest para testes
- Front do simulador: React + Vite (ou HTML simples servido pelo Express)
- Realtime: SSE ou Socket.IO (para o chat receber balões/eventos)

## Estrutura de pastas
```
hub-ia/
├─ src/
│  ├─ engine/                  ← NÚCLEO. Não importa express, mongoose, redis nem whatsapp.
│  │  ├─ types.ts              ← Kit, Agent, Conversation, Message, ports
│  │  ├─ runTurn.ts            ← orquestrador único (doc 02, etapa C)
│  │  ├─ intake.ts             ← pré-checks da msg recebida (doc 02, etapa A)
│  │  ├─ history.ts            ← buildHistory + VIDEO_HISTORY_LINE
│  │  ├─ outcomes.ts           ← handOff, disqualify, giveUp, closeAbandoned
│  │  ├─ briefing.ts           ← card de resumo
│  │  ├─ followupSweep.ts      ← sweep de inatividade
│  │  ├─ agents/
│  │  │  ├─ extractor.ts
│  │  │  ├─ qualifier.ts
│  │  │  ├─ responder.ts
│  │  │  └─ mediaAnalyzer.ts
│  │  └─ rules/                ← puros, 100% testados
│  │     ├─ requiredFields.ts
│  │     ├─ classificationRules.ts
│  │     ├─ duration.ts
│  │     ├─ timeContext.ts
│  │     ├─ ddd.ts
│  │     └─ bubbles.ts
│  ├─ providers/
│  │  ├─ openaiCompatible.ts   ← openai/together/deepseek
│  │  ├─ anthropic.ts
│  │  ├─ factory.ts
│  │  ├─ transcriber.ts        ← Groq Whisper
│  │  └─ usage.ts              ← normalizeUsage + cost
│  ├─ adapters/
│  │  ├─ simulator/            ← FASE 1
│  │  │  ├─ sessionStore.ts    ← ConversationStore em playground_sessions
│  │  │  ├─ simulatorChannel.ts← ChannelPort que só faz append na sessão + emite SSE
│  │  │  └─ eventPipeline.ts   ← PipelinePort que vira "evento" na timeline
│  │  ├─ whatsapp/             ← FASE 2
│  │  │  ├─ evolution.ts
│  │  │  └─ meta.ts
│  │  └─ crm/                  ← FASE 2
│  │     └─ kanbanPipeline.ts
│  ├─ jobs/
│  │  ├─ debouncer.ts          ← token em Redis + job com delay
│  │  └─ worker.ts
│  ├─ http/
│  │  ├─ routes/kits.ts
│  │  ├─ routes/playground.ts
│  │  └─ routes/webhooks.ts    ← FASE 2
│  └─ server.ts
├─ kits/                       ← templates JSON (copie de hub-ia-engine/kits)
├─ src/db/models/            ← schemas Mongoose (era prisma/schema.prisma)
└─ test/
```

## Ports (o contrato que separa Fase 1 da Fase 2)
Ver `esqueleto/src/engine/types.ts`. Resumo:

```ts
interface ConversationStore {
  loadState(): Promise<ConversationState>;          // status, turns, opening, classification, sent_media_ids, followup...
  saveState(patch: Partial<ConversationState>): Promise<void>;
  getKnownFields(): Promise<Record<string, unknown>>;
  saveKnownFields(fields: Record<string, unknown>): Promise<void>;
  recentMessages(limit: number): Promise<StoredMessage[]>;   // ordenadas por id asc
  updateMessage(id: string, patch: Partial<StoredMessage>): Promise<void>;
  lastInboundId(): Promise<string | null>;
  contact(): Promise<{ phone: string; name?: string; assignedToName?: string }>;
}

interface ChannelPort {
  sendText(text: string): Promise<void>;            // inclui "digitando" e persiste a outbound
  sendMedia(item: MediaItem): Promise<void>;
  sendReaction(toMessageId: string, emoji: string): Promise<void>;
  postInternalNote(text: string): Promise<void>;
}

interface PipelinePort {
  isInOnboarding(): Promise<boolean>;               // simulador: status === 'active'
  moveToHandoff(note: string): Promise<void>;
  moveToLost(note: string, lostReasonId?: number | null): Promise<void>;
  attachLabel(labelId: number): Promise<void>;
  emitEvent(e: EngineEvent): Promise<void>;         // simulador mostra; produção pode logar
}
```

## FASE 1: Simulador de chat único

**Objetivo:** conversar com o agente numa tela e ver por dentro o que cada sub-agente fez.

Endpoints:
```
GET    /api/kits                      lista kits
POST   /api/kits/import               importa kits/*.json
GET    /api/kits/:id  PUT /api/kits/:id
POST   /api/playground/:agentId/session          cria sessão {phone?, custom_fields?}
GET    /api/playground/sessions/:id              estado + mensagens
POST   /api/playground/sessions/:id/messages     {type:'text'|'image'|'document'|'audio'|'video'|'sticker', body, file?}
POST   /api/playground/sessions/:id/reset
GET    /api/playground/sessions/:id/stream       SSE (balões, typing, eventos)
GET    /api/playground/sessions/:id/logs         prompts compilados + raw por step
```

Tela:
- Coluna do chat (estilo WhatsApp): balões, reação ❤️, eventos (handoff/disqualify) como faixa central.
- Painel lateral: **custom_fields ao vivo**, roteiro (✓/✗ por campo), classificação + certeza, custo acumulado, abas com o system prompt de cada step.
- Controles: telefone (DDD), "lead de formulário" (JSON de custom_fields iniciais), upload de imagem/PDF/áudio, botão Reiniciar.

Ordem de implementação:
1. `rules/*` + testes (porte direto, doc 04)
2. `providers/openaiCompatible.ts` + teste live com Together
3. `agents/extractor|qualifier|responder` (prompts literais do doc 03)
4. `runTurn` + `history` + `outcomes` com ports
5. Adapters de simulador + rotas + SSE
6. Front
7. `mediaAnalyzer` + `transcriber`
8. `usage` + logs + painel de custo

**Critério de pronto da Fase 1:** rodar o kit `salario-maternidade` com os cenários (a) lead frio completo, (b) lead de formulário, (c) manda CTPS em foto, (d) pede humano, (e) "nunca trabalhei registrada" → desqualifica, (f) rajada de 3 mensagens, (g) provider fora → fallback.

## FASE 2: WhatsApp + kanban

1. **Webhook** Evolution/Meta → normaliza para `InboundMessage` → persiste em `messages` → `intake()` (doc 02 etapa A).
2. Download da mídia para storage antes do intake (Evolution manda base64/URL; Meta manda media id → GET).
3. **Debouncer** com BullMQ: `jobId` único não serve (precisa de "último ganha"), use o padrão token em Redis do doc 02.
4. `runTurn` com `DbConversationStore` + `WhatsappChannel` + `KanbanPipeline`.
5. **Sweep** de follow-up: BullMQ repeatable job a cada 1 min (ou `node-cron`), com o claim atômico.
6. Kanban: etapa com `role`. Mover card para fora do Onboarding chama `closeAbandoned`. Voltar ao Onboarding reseta no próximo turno.
7. Trigger de entrada: contato criado/movido para a etapa Onboarding. **O agente só responde quem está lá.**
8. Integração com CRM externo (se houver): o `KanbanPipeline` pode chamar API/webhook do CRM em vez de tabela local. O motor não muda.

Pontos de atenção da Fase 2:
- Idempotência do webhook (Meta reenvia): unique em `messages.external_id`.
- Mensagens `fromMe` digitadas pelo atendente no celular **não** devem disparar turno.
- `automation_paused` por contato = humano assumiu, IA cala.
- Mensagens de outras empresas (Meta erro 131051, "unsupported") chegam sem conteúdo: trate como não-texto.
