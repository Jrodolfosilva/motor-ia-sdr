# 11. Agentes, link público e simulador embutido

O motor é um só; cada **agente** é uma configuração dele (um segmento, um cliente, um template).
Agentes ficam no MongoDB (coleção `kits`). O salário-maternidade é só o agente inicial, importado de
`kits/salario-maternidade/kit.json` quando o banco está vazio, e vem marcado como template.

## Agentes (painel → Agentes)

- **Novo agente**: em branco ou a partir de outro agente (base). Com base, escolha quais partes do
  fluxo vêm copiadas (empresa, prompt, conduta, FAQ, recepção, perguntas, explicação, documentos,
  classificação, encerramento, follow-up, CRM, lead de teste); o resto começa vazio. Modelos de IA,
  limites e ritmo das mensagens sempre vêm da base. Mídias da base são copiadas junto.
- **Template**: marcação no agente (Configuração → Geral). Templates aparecem primeiro como base.
- **Agente aberto**: seletor na barra lateral. Simulador, Configuração e Custos usam o agente aberto.

## Link público por agente

Configuração → **Link público e teste**:

- Liga/desliga o link `https://SEU-SERVIDOR/t/<token>`. O token é aleatório (não dá para adivinhar).
- **Desligar** bloqueia na hora o link e as conversas abertas por ele. Religar volta a mesma URL.
- **Gerar novo link** troca o token: o link antigo para de funcionar.
- **Lead de teste**: primeira mensagem do lead frio e respostas do formulário de exemplo que a página
  pública usa.

Quem abre o link conversa só com aquele agente, sem login, sem ver prompts/logs/configuração, com limite:

| Variável | Para quê | Padrão |
|---|---|---|
| `DEMO_MAX_SESSIONS_PER_HOUR` | Conversas novas por IP por hora | 20 |
| `DEMO_MAX_MESSAGES` | Mensagens do lead por conversa | 60 |
| `CORS_ORIGINS` | Sites que podem embutir o simulador | `*` |

Admin logado no painel não tem limite.

## Embutir numa página do cliente

```html
<div id="hub-ia-simulador"></div>
<script src="https://SEU-SERVIDOR/embed/hub-ia-simulador.js" data-token="TOKEN-DO-LINK"></script>
```

`data-token` é obrigatório (a parte final de `/t/<token>`). Desligar o link desliga o embed também.

Atributos opcionais no `<script>`:

| Atributo | Para quê | Padrão |
|---|---|---|
| `data-title` | Texto acima do celular | (nenhum) |
| `data-lead` | `form` (veio do formulário) ou `frio` (chegou sem dados) | `form` |
| `data-lead-switch="false"` | Esconde a escolha formulário/frio | mostra |
| `data-phone` | Telefone simulado; o DDD vira o estado citado na recepção | `5511999999999` |
| `data-form` | Respostas do formulário simulado, em JSON (somam às do lead de teste do agente) | lead de teste |
| `data-target` | Seletor de onde desenhar | `#hub-ia-simulador` |
| `data-api` | URL do servidor, se for diferente da origem do script | origem do script |

Início da conversa:
- **Lead frio**: a caixa de mensagem já vem escrita com a primeira mensagem do lead de teste; é só enviar.
- **Lead de formulário**: aparece o botão **Iniciar**; ao clicar, a IA abre a conversa (recepção do
  cenário `form` + confirmação dos dados), sem esperar mensagem (`POST /api/sessions/:id/start`).

O simulador roda dentro de Shadow DOM: o CSS da página não quebra o simulador e vice-versa.

## Gerar o script

```bash
cd esqueleto/web
npm install
npm run build && npm run build:embed   # → web/dist e web/dist-embed/hub-ia-simulador.js
```

O backend serve o script em `/embed/hub-ia-simulador.js` e a página pública em `/t/<token>`.
Precisa de HTTPS na frente em produção (o microfone do navegador só funciona em HTTPS).

## API

| Rota | Quem | O quê |
|---|---|---|
| `GET /api/agents` | admin | Lista agentes + partes copiáveis |
| `POST /api/agents` `{ name, from?, sections?, template? }` | admin | Cria agente |
| `GET/PUT/DELETE /api/agents/:key` | admin | Lê, salva, exclui |
| `PUT /api/agents/:key/public-link` `{ enabled? , regenerate? }` | admin | Link público |
| `POST /api/agents/:key/media` | admin | Sobe mídia do agente |
| `POST /api/sessions` `{ agent }` ou `{ token }` | admin / visitante | Nova conversa |
| `GET /api/public/agent?t=<token>` | visitante | Nome, documentos e lead de teste |

## Persistência

- Conversas no MongoDB (`playground_sessions`), com o agente (`agentId`) e o token do link, se veio dele.
- Limites por IP no Redis: valem para todas as instâncias.
- Mídia do agente no MinIO em `kits/<agente>/media/`; arquivos que o lead manda em `sim/` (limpar de
  tempos em tempos com regra de expiração do bucket).
- Cada conversa de teste gasta créditos do Together (~R$ 0,15 a 0,45 por conversa completa).
