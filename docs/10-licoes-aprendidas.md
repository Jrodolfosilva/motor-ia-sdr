# 10. Lições aprendidas (bugs que já aconteceram)

Cada item custou debug real em produção ou em teste live. Mantenha a proteção no projeto novo.

1. **Histórico terminando em `assistant`:** remova as mensagens assistant do fim antes de chamar o LLM. Anthropic trata como prefill e continua escrevendo. OpenAI-compat (Together/DeepSeek) entende como "já respondi" e devolve **vazio**, e o lead quente recebia o fallback no 1º turno.
2. **Ordenar histórico por id, não por timestamp.** Várias mensagens no mesmo segundo embaralham a ordem: a confirmação do lead aparece antes da pergunta.
3. **Limite de histórico pega as N mais recentes:** `ORDER BY id DESC LIMIT 40` e depois inverte. (No Laravel, um `orderBy` embutido na relação fazia cortar as mais antigas.)
4. **Gate do roteiro em código:** o qualifier nem é chamado com campo faltando. Sem isso o LLM classificava cedo "porque a conversa parecia completa".
5. **Desqualificar exige regra quando a label tem `rules`.** É a única decisão sem volta.
6. **Normalizar duração** ("oito meses" = "8 meses"), porque o qualifier só lê o valor salvo.
7. **Data de hoje em todo prompt.** Sem isso: "15/07 (desse ano)" salvo literal; perguntou se a mãe que já pariu ainda estava grávida.
8. **"(há N meses)" calculado em código** e injetado no roteiro. O modelo não faz conta de data.
9. **Frase do estado (DDD) concatenada em código** na saudação. O modelo barato pulava quando também era instruído a "não repetir a saudação".
10. **Saudação enviada pelo código + prompt dizendo "já foi enviada, não repita".** Senão o bot cumprimenta duas vezes.
11. **Lead frio: consentimento e silêncio.** Não emende a 1ª pergunta; espere o lead responder.
12. **Resposta vazia (sem texto e sem tool) = erro:** cai no fallback, nunca silêncio.
13. **Abortar balões se o lead escreveu no meio.** Senão o bot responde a pergunta anterior depois da msg nova.
14. **Reação/sticker não contam como "nova mensagem"** para o aborto dos balões nem para o sweep.
15. **Turno perdido** (worker reiniciou): o sweep detecta inbound não processada > debounce+120s e reagenda.
16. **Claim atômico no follow-up** (`UPDATE ... WHERE followup_step_sent = anterior`). Evita mandar duplicado em corrida com a resposta do lead.
17. **`closeAbandoned` quando humano tira o card do Onboarding.** Senão a conversa fica active para sempre e o follow-up dispara em cima do humano.
18. **Arquivo analisado grava resultado mesmo se falhou** (`{failed:true}`). Não cobra 2x nem trava em loop.
19. **Linha de arquivo no histórico + instrução "reaja como quem viu".** Senão o modelo diz "recebi a descrição da sua imagem" e quebra a persona.
20. **Retry no provider** (timeout/429/5xx, 2 tentativas). 1 em 40 chamadas do Together dava timeout.
21. **Texto que o modelo ignora no system prompt → coloque no `question` do campo do roteiro.** Foi assim que o pitch passou a sair.
22. **Pares "Ruim → Bom" no prompt** funcionam melhor que regra abstrata ("não abra toda mensagem com 'Que ótimo!'").
23. **Temperaturas:** 0.1 para extractor, qualifier e visão (consistência); 0.6 para o responder (evita soar roteirizado).
24. **Dois runners copiados (produção vs playground) divergem.** No projeto novo: um runner, adapters diferentes.
25. **Decisões de produto, não reabrir:** sem guard de senha gov.br no prompt; sem horário comercial; sem reativação em massa; follow-up por IA fora do hub.
