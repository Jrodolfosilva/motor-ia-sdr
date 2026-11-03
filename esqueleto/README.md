# Esqueleto TypeScript do motor

Ponto de partida para o projeto Express. Porte fiel da lógica do Laravel, com **um runner só** e adapters.

```bash
# tudo no Docker (app + MongoDB + Redis + MinIO), a partir da raiz do repo:
docker load -i ../minio-RELEASE.2025-02-03T21-03-04Z-cpuv1.tar   # 1ª vez
docker compose up -d --build      # http://localhost:3000 · MinIO console http://localhost:9001

# ou só a infra no Docker e o servidor local:
docker compose up -d mongo redis minio
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
- `adapters/simulator.ts`: sessão em memória usada pelo motor; `adapters/sessionRepo.ts` grava no MongoDB
- `adapters/kitRepo.ts`: kit no MongoDB (coleção `kits`, importado do kit.json na 1ª subida)
- `adapters/storage.ts`: mídia do kit e do lead no MinIO; `adapters/rateLimit.ts`: limites do modo público no Redis
- `server.ts` + `public/index.html`: chat simples com painel de estado, campos e prompts

## TODO (na ordem sugerida)
1. `providers/anthropic.ts` (docs/05)
2. `providers/usage.ts`: normalizeUsage + custo, ligar no `UsageRecorder` do simulador
3. `engine/agents/mediaAnalyzer.ts` + upload de imagem/PDF no simulador (docs/03 §4)
4. Transcrição de áudio (Groq) antes do `intake`
5. `engine/briefing.ts`: card completo de handoff (docs/07)
6. ~~Persistir sessões em MongoDB~~ (feito) · Redis para debounce/locks (conectado, falta usar)
7. Tela: custom_fields iniciais (simular lead de formulário), SSE para balões com "digitando"
8. **Fase 2:** adapters WhatsApp (Evolution/Meta), `KanbanPipeline`, debouncer BullMQ, sweep de follow-up (docs/09)
