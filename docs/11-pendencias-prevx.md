# 11 — Pendências: SDR PrevX (Fale Fácil + Bitrix)

Checklist para colocar o agente `sdr_prevx_fale_facil_bitrix` em teste real.
Estado em 2026-11-19: produção ainda **sem** o commit `e1ff52b` (rotas `/hooks/*` respondem `Cannot POST`).

Legenda: **[nós]** = time hub-ia · **[PrevX]** = cliente / admin do Bitrix

## 1. Deploy
- [ ] **[nós]** Easypanel → `zyx` → `hub-ia` → aba Ambiente: `PUBLIC_BASE_URL=https://zyx-hub-ia.6jqf4m.easypanel.host`
- [ ] **[nós]** Implantar (sobe o commit `e1ff52b`)
- [ ] **[nós]** Conferir: `POST /hooks/bitrix/x/lead` deve responder `404` vazio (rota existe), não `Cannot POST`

## 2. Agente no banco de produção
- [ ] **[nós]** Levar `kits/sdr-prevx-fale-facil-bitrix/kit.json` para o Mongo de produção
  (console do container `app`: `npx tsx src/scripts/importKit.ts ../kits/sdr-prevx-fale-facil-bitrix/kit.json`; o painel não importa kit)

## 3. Acessos do cliente
- [ ] **[PrevX]** API key do Fale Fácil (aba Desenvolvedor da conexão +55 11 97063-9340)
- [ ] **[PrevX]** Webhook de entrada do Bitrix — admin cria em Aplicativos → Webhooks → Webhook de entrada, escopos `crm`, `user`, `imopenlines`
  (formato `https://prevx.bitrix24.com.br/rest/<id>/<codigo>/`)
- [ ] **[PrevX]** Texto aprovado do template `atendimento_4`

## 4. Painel → aba "Fale Fácil + Bitrix"
- [ ] Salvar API key + webhook do Bitrix → **Testar** (os dois ok)
- [ ] Colar o texto do `atendimento_4` no template `tpl_atendimento_4`
- [ ] Passagem (Pré-qualificada): escolher responsável e fila — hoje `transfer_id` e `assign_user_id` estão `null`
- [ ] ⚠️ Telefones de teste: colocar o nosso número **antes** de ligar (lista vazia = IA responde todos os leads reais)
- [ ] Ligar a integração (`enabled: true`)
- [ ] Exportar banco → `kit.json` e commitar

## 5. Webhook no Fale Fácil
- [ ] ⚠️ Antes de trocar: confirmar se o n8n de teste (`n8n.wativo.shop`) é o que move o lead para EM ATENDIMENTO — o Fale Fácil só aceita 1 webhook por conexão
- [ ] Trocar a URL do webhook para `https://zyx-hub-ia.6jqf4m.easypanel.host/hooks/falefacil/<token>` (URL completa aparece no painel)
- [ ] Se usar token no painel, enviar no header `x-webhook-token`

> Webhook do Bitrix (`/hooks/bitrix/<token>/lead?id={{ID}}`) **não** é necessário agora: `opening_mode = external`
> (robô do Bitrix envia o `#atendimento_4`; o motor assume na resposta da lead).

## 6. Teste ponta a ponta
- [ ] Criar lead no Bitrix com o telefone de teste → robô envia o template
- [ ] Responder no WhatsApp → IA responde (Monitor do painel)
- [ ] Etapa do lead muda conforme o mapa (TEMPLATE ENVIADO → EM ATENDIMENTO → PRÉ-QUALIFICADA / SEM DIREITO)
- [ ] Comentários aparecem na timeline do lead
- [ ] Mandar **áudio** e **imagem** — confirmar se a mídia recebida (Meta) vem com URL baixável e é transcrita/lida
- [ ] Passagem: lead transferido para o responsável/fila escolhidos
- [ ] Follow-up fora da janela de 24h sai como template
