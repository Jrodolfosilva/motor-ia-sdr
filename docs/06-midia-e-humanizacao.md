# 06. Mídia e humanização

## Matriz de tipos de mensagem recebida

| Tipo | Comportamento |
|---|---|
| text | turno normal (checa keywords de handoff antes) |
| audio | transcreve → vira texto. Falhou → **handoff `media_received`** |
| image | visão disponível → turno (lida no job). Sem visão → handoff |
| document `.pdf` | igual imagem (texto do PDF primeiro, render se for scan) |
| document outro | handoff |
| video | turno; histórico ganha `VIDEO_HISTORY_LINE` |
| sticker | ignora (nem turno nem handoff) |
| reaction | ignora; **não** conta como "lead escreveu de novo" |

`VIDEO_HISTORY_LINE`:
```
[Vídeo enviado pela lead - você não consegue assistir vídeos. Diga com naturalidade que não conseguiu abrir o vídeo, peça para mandar em foto/print ou escrever, e siga o roteiro]
```

## Leitura de arquivos
- Feita **dentro do turno** (job), não no webhook: uma rajada de 3 fotos é lida num turno só e o webhook fica rápido.
- Resultado gravado na mensagem (`ai_analysis`), inclusive `{failed:true}`, para **nunca cobrar 2x**.
- Qualquer arquivo novo que falhou → handoff `media_received`.
- Tipos que ganham reação ❤️: `ultrassom, cartao_gestante, teste_gravidez, certidao_nascimento` (mover para config do kit).
- Reação é best-effort: falhou, ignora. Registrada como mensagem `reaction` ("Reagiu com ❤️") com `reply_to`.

## Balões
- Só o texto do responder. Parágrafos (linha em branco) viram mensagens separadas, máx. 3.
- Antes de cada balão: se chegou inbound nova (text/audio/image/document/video) desde o início do turno → **para de enviar** o resto. O debounce já agendou outro turno que vai ler a nova mensagem.

## "Digitando..."
- Evolution: `sendPresence(composing, delay)` + `sleep(delay)` com `delay = clamp(ceil(len/20), 2, 6)` s.
- Meta Cloud API: faz sozinho.
- **No Node, não bloqueie o event loop:** `await sleep(ms)` dentro do worker do job está OK.
- Simulador: anime o indicador no front com o mesmo delay (ou ignore).

## Biblioteca de mídia do kit
Item: `{id, type: image|video|document|audio, path, mime, file_name, caption, when_to_use, send_on_handoff}`.
- `send_on_handoff = true` → **não** é oferecido ao responder; vai automaticamente após `handoff_message`.
- Demais → oferecidos via tool `enviar_midia` (enum dos ids ainda não enviados).
- `sent_media_ids` na conversa garante no máximo 1 envio por item.
- No original, cada envio copia o arquivo (para a purga de mídia antiga não apagar o original da biblioteca). No projeto novo, use storage (S3/R2/disco) e guarde a referência; não precisa copiar se a purga não tocar a pasta da biblioteca.

## Saudação em 2 passos
1. Turno 1: `greeting_example` (+ frase do DDD) é enviada **pelo código**.
2. Lead frio + `consent_message` → envia o consentimento e **para**. A IA só fala depois que o lead responder.
3. Lead quente (formulário) → logo após a saudação, o responder já manda a resposta personalizada, e o prompt diz para não repetir a saudação.
