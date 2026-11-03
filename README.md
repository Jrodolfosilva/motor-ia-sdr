# Hub de IA: motor de orquestração (extraído do SendGreen/ZeroMsg)

Esta pasta guarda toda a lógica do **Hub de IA**, o motor que faz agentes de atendimento (SDR) conversarem com leads, coletarem dados, classificarem e passarem para um humano. O objetivo é **reimplementar esse motor num projeto Express (Node + TypeScript) independente do CRM**.

- **Fase 1:** uma tela de chat único para simular conversas (equivalente ao "Testar IA"/playground atual).
- **Fase 2:** conectar com WhatsApp real (Evolution / Meta Cloud API) e com etapas de um kanban/CRM.

## Como ler esta pasta

| Pasta / arquivo | O que tem |
|---|---|
| `docs/01-arquitetura.md` | Conceitos (Kit, Agente, Conversa, papéis), diagrama geral |
| `docs/02-fluxo-do-turno.md` | **O coração:** passo a passo do que acontece quando chega uma mensagem |
| `docs/03-sub-agentes-e-prompts.md` | Extractor, Qualifier e Responder: prompts, tools, temperaturas |
| `docs/04-regras-deterministicas.md` | Partes em código, sem LLM: gate do roteiro, regras de classificação, datas, DDD |
| `docs/05-providers-e-custos.md` | Contrato de provider, Together/OpenAI/Anthropic, retry, catálogo de modelos, custo |
| `docs/06-midia-e-humanizacao.md` | Áudio, imagem/PDF (visão), vídeo, sticker, balões, "digitando", reação ❤️, biblioteca de mídia |
| `docs/07-handoff-desqualificacao-followup.md` | Saídas da conversa: handoff, desqualificação, follow-up por inatividade, card de resumo |
| `docs/08-modelo-de-dados.md` | Modelo de dados proposto. **Banco decidido: MongoDB + Redis** (SQL fica como referência) |
| `docs/09-plano-express.md` | **Estrutura de pastas Express, adaptadores, Fase 1 → Fase 2, checklist** |
| `docs/10-licoes-aprendidas.md` | Bugs e armadilhas que já custaram caro. Não repetir. |
| `esqueleto/` | Esqueleto TypeScript do motor (tipos, runner, sub-agentes, regras, provider Together, simulador mínimo). Typecheck limpo e 15 testes com LLM fake passando. Ainda não testado com chave real. |
| `kits/salario-maternidade/` | Template de kit real (JSON + system prompt) para usar de fixture |
| `referencia-laravel/` | **Cópia fiel** do código PHP original (services, models, migrations, config). Consulte quando a doc não bastar |

## Resumo em 30 segundos

```
mensagem chega → pré-checks (áudio→texto, keyword de humano, mídia ilegível)
             → debounce (junta rajada de msgs em 1 turno)
             → TURNO:
                 1ª msg? manda saudação (+ consentimento se lead frio)
                 lê imagens/PDF pendentes (visão)
                 EXTRACTOR  (LLM, temp 0.1) → salva campos do roteiro
                 QUALIFIER  (regra ou LLM, temp 0.1) → só roda com roteiro COMPLETO
                     classificou? → HANDOFF (qualify) ou DESQUALIFICA (disqualify) → fim
                 RESPONDER  (LLM, temp 0.6) → texto + tool enviar_midia
                 quebra em balões (≤3) → envia com "digitando"
                 aborta balões se lead escreveu de novo no meio
```

Princípio central: **o LLM nunca decide sozinho o que pode ser decidido em código.** O gate "roteiro completo" é código. Regras de elegibilidade são código. Datas e DDD são código. O LLM só redige, extrai e julga casos ambíguos.

## Origem

Código original: `repo/` (Laravel 13 + Inertia/React). Arquivos principais:
- `app/Services/Ai/AiOnboardingAgentRunner.php`: runner de produção (WhatsApp + kanban)
- `app/Services/Ai/AiPlaygroundRunner.php`: runner do simulador (é a referência da **Fase 1**)
- `app/Services/Ai/Onboarding/*`: sub-agentes e regras
- `app/Services/WhatsApp/WebhookHandler.php::maybeRunAiOnboardingAgent()`: gatilho
