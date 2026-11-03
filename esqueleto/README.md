# Esqueleto TypeScript do motor

Ponto de partida para o projeto Express. Porte fiel da lógica do Laravel, com **um runner só** e adapters.

```bash
npm install
npm test                          # 15 testes: regras + orquestração com LLM fake
TOGETHER_API_KEY=sk-... npm run dev   # simulador em http://localhost:3000
KIT_PATH=../kits/outro/kit.json ...   # outro kit
```

## O que está pronto
- `engine/rules/*`: roteiro, regras de classificação, datas, duração, DDD, contexto de tempo, balões (testados)
- `engine/agents/*`: extractor, qualifier, responder (prompts literais do original)
- `engine/runTurn.ts`: `intake()` + `runTurn()` + `handOff()` + `disqualify()` + histórico
- `providers/openaiCompatible.ts`: Together/OpenAI/DeepSeek com timeout e retry
- `adapters/simulator.ts`: sessões em memória (Fase 1)
- `server.ts` + `public/index.html`: chat simples com painel de estado, campos e prompts

## TODO (na ordem sugerida)
1. `providers/anthropic.ts` (docs/05)
2. `providers/usage.ts`: normalizeUsage + custo, ligar no `UsageRecorder` do simulador
3. `engine/agents/mediaAnalyzer.ts` + upload de imagem/PDF no simulador (docs/03 §4)
4. Transcrição de áudio (Groq) antes do `intake`
5. `engine/briefing.ts`: card completo de handoff (docs/07)
6. Persistir sessões em MongoDB (docs/08) + Redis para debounce/locks
7. Tela: custom_fields iniciais (simular lead de formulário), SSE para balões com "digitando"
8. **Fase 2:** adapters WhatsApp (Evolution/Meta), `KanbanPipeline`, debouncer BullMQ, sweep de follow-up (docs/09)
