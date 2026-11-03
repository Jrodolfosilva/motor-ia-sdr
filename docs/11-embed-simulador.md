# 11. Simulador embutido (script para página do cliente)

Só o celular do simulador, para colar em qualquer página e mandar o cliente testar o agente.
Sem painéis internos (estado, prompts, custos, editor).

## Como colar na página

```html
<div id="hub-ia-simulador"></div>
<script src="https://SEU-SERVIDOR/embed/hub-ia-simulador.js"></script>
```

Atributos opcionais no `<script>`:

| Atributo | Para quê | Padrão |
|---|---|---|
| `data-title` | Texto acima do celular | (nenhum) |
| `data-lead` | `form` (veio do formulário) ou `frio` (chegou sem dados) | `form` |
| `data-lead-switch="false"` | Esconde a escolha formulário/frio | mostra |
| `data-phone` | Telefone simulado; o DDD vira o estado citado na recepção | `5511999999999` |
| `data-form` | Respostas do formulário simulado, em JSON: `'{"Você está grávida atualmente?":"Sim"}'` | só o nome |
| `data-target` | Seletor de onde desenhar | `#hub-ia-simulador` |
| `data-api` | URL do servidor, se for diferente da origem do script | origem do script |

Página pronta para mandar o link direto: `https://SEU-SERVIDOR/demo`.

O simulador roda dentro de Shadow DOM: o CSS da página não quebra o simulador e vice-versa.

## Gerar o script

```bash
cd esqueleto/web
npm install
npm run build:embed        # → web/dist-embed/hub-ia-simulador.js (~60 KB gzip)
```

O backend serve esse arquivo em `/embed/hub-ia-simulador.js`.

## Subir o servidor em modo público

```bash
cd esqueleto
npm install
# variáveis (no painel da hospedagem ou no .env):
#   TOGETHER_API_KEY=...            obrigatório
#   PUBLIC_DEMO=1                   obrigatório para expor ao cliente
#   CORS_ORIGINS=https://site-do-cliente.com   (padrão: * = qualquer site)
#   DEMO_MAX_SESSIONS_PER_HOUR=20   conversas novas por IP por hora
#   DEMO_MAX_MESSAGES=60            mensagens da lead por conversa
#   PORT=3000
npx tsx src/server.ts
```

Precisa de Node 22+ e HTTPS na frente (a hospedagem normalmente já dá). O microfone do navegador
só funciona em página HTTPS.

### O que o modo público (`PUBLIC_DEMO=1`) faz

- Bloqueia `/api/agent` (ler/editar configuração e prompt) e `/api/cost/*` → 403.
- Esconde os prompts enviados à IA (`logs` vazio).
- Limita conversas novas por IP/hora e mensagens por conversa (resposta 429 com aviso amigável).
- O editor do agente e a calculadora **não** funcionam nesse servidor: configure o agente numa
  instância interna (sem `PUBLIC_DEMO`) e suba o `kit.json` junto.

## Limitações atuais (Fase 1)

- Conversas ficam em memória: reiniciar o servidor apaga as conversas abertas (o simulador
  mostra "Esta conversa expirou. Clique em Recomeçar").
- Limites também em memória, por instância. Com mais de uma instância, mover para Redis.
- Arquivos que a lead manda ficam em `esqueleto/.sim-media/` (limpar de tempos em tempos).
- Cada conversa de teste gasta créditos do Together (~R$ 0,15 a 0,45 por conversa completa).
