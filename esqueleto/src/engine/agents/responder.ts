import { modelFor, type Agent, type CallLog, type ChatMessage, type LlmProvider, type MediaItem, type ToolDef } from '../types';
import { RequiredFieldsStatus, type RoteiroProgress } from '../rules/requiredFields';
import { faqPickLine, type FaqPick } from '../faq';
import { elapsedNote } from '../rules/classificationRules';
import { conductBlock } from '../guardrails';

export { elapsedNote };
import { inState, stateFor, timeContextLine } from '../rules/misc';
import {
  EXPLANATION_MARK, explanationMessages, explanationTriggerKeys, receptionFor, receptionLine, type ExplanationState,
} from '../reception';

const TEMPERATURE = 0.6;

export function availableMedia(agent: Agent, sentIds: string[]): MediaItem[] {
  return agent.kit.media_library.filter((m) => !m.send_on_handoff && !sentIds.includes(m.id));
}

function mediaTool(items: MediaItem[]): ToolDef {
  return {
    name: 'enviar_midia',
    description: 'Envia ao lead um arquivo da biblioteca do escritório (ex: depoimentos de clientes). Chame junto com a sua resposta em texto, só quando o momento descrito no item fizer sentido.',
    parameters: {
      type: 'object',
      properties: { midia_id: { type: 'string', enum: items.map((i) => i.id), description: 'Id do item da biblioteca.' } },
      required: ['midia_id'],
    },
  };
}

function faqTool(indices: number[]): ToolDef {
  return {
    name: 'responder_faq',
    description: 'Envia a resposta pronta (texto, áudio ou vídeo da equipe) de uma PERGUNTA FREQUENTE que a lead acabou de fazer. Chame só quando ela perguntar aquilo.',
    parameters: {
      type: 'object',
      properties: { pergunta: { type: 'integer', enum: indices, description: 'Número da pergunta frequente.' } },
      required: ['pergunta'],
    },
  };
}

const FILE_TYPE_LABEL = { image: 'foto/print', pdf: 'PDF' } as const;

const PENDING_TAG = { depois: 'DEPOIS', nao_sabe: 'NÃO SABE', vaga: 'RESPOSTA VAGA', nao_tem: 'NÃO TEM', recusou: 'RECUSOU' } as const;

/** Marcação de pendência do item para o prompt, ou null se não há pendência. */
function pendingLine(status: RequiredFieldsStatus, key: string): string | null {
  const p = status.pendingFor(key);
  if (!p) return null;
  const tag = PENDING_TAG[p.status];
  const said = p.detail ? ` (ela disse: "${p.detail}")` : '';
  if (status.isPendingResolved(key)) return `[${tag} - LIBERADO]${said}`;
  if (p.status === 'depois') return `[${tag}]${said}`;
  const left = status.insistLeft(key);
  return `[${tag} - REFORCE E PEÇA DE NOVO${left > 1 ? '' : ', última tentativa'}]${said}`;
}

/** Orientação para reforçar um item sem resposta válida: por que precisamos + como conseguir. */
function insisting(status: RequiredFieldsStatus, key: string): boolean {
  const p = status.pendingFor(key);
  return !!p && p.status !== 'depois' && !status.isPendingResolved(key);
}

function insistInfo(status: RequiredFieldsStatus, key: string, why?: string | null, help?: string | null): string {
  if (!insisting(status, key)) return '';
  return [
    why ? `por que precisamos: ${why}` : null,
    help ? `como ela consegue: ${help}` : null,
  ].filter(Boolean).map((l) => `\n    ${l}`).join('');
}

export function buildResponderPrompt(
  agent: Agent, known: Record<string, unknown>, isFirstTurn: boolean, phone: string | null,
  media: MediaItem[], now?: Date, progress: RoteiroProgress = {}, explanation: ExplanationState = 'off',
  notices: string[] = [], onlyUnusable = false, faqNext: Record<number, FaqPick> = {},
): string {
  const parts: string[] = [agent.system_prompt, timeContextLine(phone, now)];
  const kit = agent.kit;

  if (kit.company_info) parts.push(`Informações do escritório/empresa:\n${kit.company_info}`);

  const cold = !new RequiredFieldsStatus(agent.required_fields, known, agent.required_documents).hasAnyKnownData();
  const reception = receptionFor(agent, cold ? 'volume' : 'form');
  const st = phone ? stateFor(phone) : null;
  if (st && isFirstTurn && !reception.messages.length) {
    parts.push(`O DDD do lead indica que ele está no estado de ${st.name} (${st.uf}). Inclua isso na sua primeira mensagem: mencione de forma natural que o escritório atua em todo o Brasil, com forte presença ${inState(st)}.`);
  }

  parts.push('ARQUIVOS DA LEAD: mensagens entre colchetes como "[Imagem enviado pela lead - ...]" ou "[PDF enviado pela lead - ...]" são o que você viu na foto ou no PDF que ela mandou. Reaja como quem olhou o arquivo (ex: confirme a data que aparece nele, comemore o ultrassom), nunca diga que recebeu uma descrição ou um texto automático. Se o arquivo estiver pouco legível, peça com gentileza para reenviar.');

  const status = new RequiredFieldsStatus(agent.required_fields, known, agent.required_documents, progress);
  parts.push(status.hasAnyKnownData()
    ? 'MODO DE ATENDIMENTO - LEAD DE FORMULÁRIO (pré-qualificado): este lead já respondeu um formulário (anúncio/landing page). NÃO pergunte do zero o que já temos. Cumprimente pelo nome (se houver), mostre em UMA mensagem curta os dados que vieram do formulário e peça para ela confirmar (ex: "Vi aqui que ..., confere?"). Depois da confirmação, o foco é pedir os DOCUMENTOS que comprovam essas informações, um por vez, explicando onde conseguir quando ela não souber. Perguntas que ainda faltam entram no meio, uma de cada vez.'
    : 'MODO DE ATENDIMENTO - LEAD FRIO (volume, sem cadastro): faça a pré-qualificação completa. Recepção calorosa, colete as PERGUNTAS do roteiro UMA por vez e, quando o caso fizer sentido, peça os DOCUMENTOS, um por vez.');

  if (kit.faq.length) {
    const lines = kit.faq.map((e, i) => {
      const pick = faqNext[i];
      const base = `- [${i}] Q: ${e.question} | A: ${e.answer}`;
      return pick ? `${base}\n    RESPOSTA PRONTA: se ela perguntar isso, chame responder_faq(${i}) - ${faqPickLine(pick)}` : base;
    });
    const hasReady = Object.keys(faqNext).length > 0;
    parts.push(`### BASE DE CONHECIMENTO (PERGUNTAS FREQUENTES)\nVocê pode responder às seguintes dúvidas caso o lead pergunte:\n${lines.join('\n')}${hasReady ? '\nPerguntas com RESPOSTA PRONTA: use responder_faq (a resposta da equipe sai automaticamente, logo depois da sua mensagem). Sem resposta pronta: responda você, com base no A.' : ''}`);
  }

  if (explanation !== 'off') {
    const lines = explanationMessages(agent).map((m, i) => `${i + 1}) ${receptionLine(m)}`).join('\n');
    const label = (k: string) => agent.required_fields.find((f) => f.key === k)?.label ?? k;
    if (explanation === 'pending') {
      parts.push(`MÓDULO DE EXPLICAÇÃO: a explicação do benefício (como funciona, valores, por que precisamos dos documentos) é enviada AUTOMATICAMENTE assim que estas perguntas estiverem respondidas: ${explanationTriggerKeys(agent).map(label).join('; ')}. Até lá: NÃO faça pitch, NÃO fale de valores ou prazos de pagamento e NÃO peça documentos - siga com as perguntas que faltam. Se ela perguntar sobre valores, diga que já já explica tudo e volte à pergunta.`);
    } else if (explanation === 'inline' || explanation === 'inline_wait' || explanation === 'just_sent') {
      const msgs = explanationMessages(agent);
      const last = msgs.length ? receptionLine(msgs[msgs.length - 1]) : '';
      // primeiro documento que falta + para que ele serve (perguntas que ele comprova)
      const st = new RequiredFieldsStatus(agent.required_fields, known, agent.required_documents, progress);
      const doc = st.missingDocuments()[0];
      const purpose = doc?.validates?.length ? doc.validates.map((k) => label(k).split(/[(.]/)[0].trim().toLowerCase()).join(' e ') : null;
      const askDoc = `peça o primeiro documento que falta${doc ? ` (${doc.label})` : ''}, dizendo em poucas palavras para que ele serve${purpose ? ` (ele comprova: ${purpose})` : ''}. Não repita nada da explicação (nada de "grande possibilidade", "análise completa", valores ou honorários). Curto, no tom de quem continua a conversa, sem abertura ("Perfeito", "Ótimo", "Entendi") e sem o nome dela no começo. Exemplos: "O primeiro é…", "Pra confirmar…, consegue me mandar…?", "Pra começar, me envia…". Se a seção URGÊNCIA se aplicar, inclua a frase de prazo nesse pedido.`;
      if (explanation === 'just_sent') {
        parts.push(`EXPLICAÇÃO ACABOU DE SER ENVIADA (automaticamente, por você, logo antes desta sua resposta):\n${lines}\nA SUA última mensagem foi: ${last}\nNÃO reaja de novo ao que a lead disse antes. Escreva a PRÓXIMA frase, continuando dali: ${askDoc}`);
      } else {
        parts.push([
          'EXPLICAÇÃO VAI SAIR AGORA, NO MEIO DA SUA RESPOSTA. Estas mensagens fixas serão enviadas automaticamente por você:',
          lines,
          `Escreva sua resposta em DUAS partes, separadas por uma linha contendo só ${EXPLANATION_MARK}:`,
          '- ANTES (sai antes da explicação): só uma reação curta e natural ao que a lead acabou de dizer, se houver o que reagir (ex: parabéns pelo bebê que nasceu, agradecer um documento ou um dado que ela explicou). Se a mensagem dela foi só uma confirmação ("sim", "isso", "confere"), deixe VAZIO. Não peça nada e não explique o benefício aqui.',
          explanation === 'inline_wait'
            ? `- DEPOIS: deixe VAZIO (a explicação termina em: ${last} - e a lead vai responder).`
            : `- DEPOIS (sai logo após a explicação, que termina em: ${last}): continue dali - ${askDoc}`,
          `Formato:\n<reação ou nada>\n${EXPLANATION_MARK}\n<continuação>`,
        ].join('\n'));
      }
    } else {
      parts.push(`Explicação do benefício já enviada antes nesta conversa (não repita):
${lines}`);
    }
  }

  if (reception.messages.length) {
    const sent = reception.messages.map((m, i) => `${i + 1}) ${receptionLine(m)}`).join('\n');
    parts.push(isFirstTurn
      ? `RECEPÇÃO JÁ ENVIADA: estas mensagens já saíram automaticamente, antes da sua resposta:\n${sent}\nNão repita nem parafraseie a apresentação, nem abra com um novo cumprimento ("oi", "olá", "tudo bem?"). Siga direto para o próximo passo${cold ? ' (primeira pergunta do roteiro)' : ' (confirmar os dados do formulário e depois pedir os documentos)'}, no mesmo tom.`
      : `Recepção que abriu esta conversa (referência de tom; não repita):\n${sent}`);
  }

  if (status.fields.length) {
    const lines = status.fields.map((f) => {
      const v = status.value(f.key);
      const note = typeof v === 'string' ? elapsedNote(v, now) : '';
      const pend = pendingLine(status, f.key);
      if (pend) return `- ${pend} "${f.label}" - pergunta: "${f.question}"${insistInfo(status, f.key, f.why, f.help)}`;
      switch (status.questionState(f)) {
        case 'missing':
          return `- [FALTA] "${f.label}" - pergunte algo como: "${f.question}"`;
        case 'to_confirm':
          return `- [CONFIRMAR] "${f.label}" veio do formulário como "${String(v)}"${note} - confirme com ela${f.confirm_question ? ` (ex: "${f.confirm_question.replaceAll('{valor}', String(v))}")` : ''}, não pergunte do zero.`;
        case 'confirmed': {
          const docs = status.validatedBy(f.key).map((d) => d.label);
          return `- [OK] "${f.label}": "${String(v)}"${note}${docs.length ? ` - comprovado por: ${docs.join(', ')}` : ' - confirmado por ela'}. Não pergunte de novo.`;
        }
        default:
          return `- [OK] "${f.label}": "${String(v)}"${note}. Não pergunte de novo.`;
      }
    });
    parts.push(`PERGUNTAS DO ROTEIRO (uma de cada vez, sem soar como formulário):\n${lines.join('\n')}`);
  }

  if (status.documents.length) {
    const lines = status.documents.map((d) => {
      const v = status.value(d.key);
      if (v !== null && v !== '') return `- [RECEBIDO] ${d.label}: ${String(v)}`;
      const pend = pendingLine(status, d.key);
      const alt = [
        d.accepted.length > 1 ? `outros que também servem: ${d.accepted.join(', ')}` : null,
        d.how_to_get ? `onde conseguir: ${d.how_to_get}` : null,
      ].filter(Boolean).join(' | ');
      if (pend) {
        const again = insisting(status, d.key);
        return `- ${pend} ${d.label}${again ? ` - peça algo como: "${d.request_message}"` : ''}${insistInfo(status, d.key, d.why)}${again && alt ? `\n    alternativas: ${alt}` : ''}`;
      }
      const info = [
        `formato: ${d.file_types.map((t) => FILE_TYPE_LABEL[t]).join(' ou ') || 'foto/print ou PDF'}`,
        d.accepted.length ? `serve: ${d.accepted.join(', ')}` : null,
        d.validates?.length ? `comprova: ${d.validates.map((k) => agent.required_fields.find((f) => f.key === k)?.label ?? k).join('; ')}` : null,
        d.condition ? `pedir só se: ${d.condition}` : null,
        `peça algo como: "${d.request_message}"`,
        d.how_to_get ? `se ela não souber onde conseguir ou não tiver, explique: ${d.how_to_get}` : null,
      ].filter(Boolean);
      return `- [FALTA] ${d.label}\n    ${info.join('\n    ')}`;
    });
    parts.push(`DOCUMENTOS DO ROTEIRO (peça um por vez; quando chegar, reaja ao que aparece no arquivo e confira com o que ela disse):\n${lines.join('\n')}`);
  }

  if (status.fields.length || status.documents.length) {
    const onlyDeferredLeft = status.missing().length > 0 && status.missing().every((x) => status.pendingFor(x.key)?.status === 'depois');
    parts.push([
      'QUANDO A RESPOSTA NÃO VEM COMO ESPERADO (não sabe, vaga, estranha, recusa, não tem):',
      '- NÃO aceite e siga em frente: os itens do roteiro são necessários para o pedido. Item marcado "REFORCE E PEÇA DE NOVO": acolha em 1 frase curta (sem julgar), diga por que precisamos (use "por que precisamos"), oriente como ela consegue a informação (use "como ela consegue" / "alternativas") e peça de novo, de um jeito simples. No máximo 3 frases.',
      '- Aceite aproximação quando servir (mês/ano, "uns 5 meses", "no começo do ano") e diga isso a ela ("não precisa ser o dia exato").',
      '- Cada reforço tem que soar diferente do anterior (outra explicação, outro caminho pra descobrir). Nunca repita a mesma frase.',
      '- [NÃO SABE] / [RESPOSTA VAGA]: ajude a lembrar com referências (mês, época do ano, quanto tempo antes da gravidez) e diga onde olhar.',
      '- [NÃO TEM]: ofereça a alternativa (outro documento que serve ou onde conseguir).',
      '- [RECUSOU]: com calma e sem pressão, explique por que é necessário e pergunte de novo.',
      '- Mensagem sem sentido ou que não responde a pergunta: peça de novo com gentileza, reformulando.',
      '- [DEPOIS]: combine com leveza ("sem problema, me manda quando puder") e siga com os outros itens; não peça de novo enquanto houver outros itens pra resolver.',
      '- [LIBERADO]: já insistimos o suficiente. Não peça mais esse item (a equipe resolve depois) e siga com o próximo.',
      onlyDeferredLeft ? '- AGORA só faltam itens [DEPOIS]: lembre UMA vez, com gentileza, do que ficou de mandar, e diga que fica no aguardo.' : null,
    ].filter(Boolean).join('\n'));
  }

  const unmatched = Object.entries(status.unmatched());
  if (unmatched.length) {
    parts.push(`Outros dados já registrados no perfil do contato, de origem externa (ex: formulário/anúncio) - as chaves não seguem um padrão fixo, interprete pelo conteúdo:\n${unmatched.map(([k, v]) => `- "${k}": "${String(v)}"`).join('\n')}`);
  }

  if (media.length) {
    const lines = media.map((m) => `- id "${m.id}" (${m.type}):${m.caption ? ` "${m.caption}" -` : ''} enviar quando: ${m.when_to_use ?? 'fizer sentido na conversa'}`);
    parts.push(`BIBLIOTECA DE ARQUIVOS DO ESCRITÓRIO - você pode enviar um destes com a função enviar_midia, junto com sua resposta em texto, quando o momento descrito chegar (cada um no máximo uma vez; não envie vários de uma vez sem motivo):\n${lines.join('\n')}`);
  }

  const conduct = conductBlock(agent);
  if (conduct) parts.push(conduct);

  if (notices.length) {
    const sent = notices.map((n) => `"${n}"`).join(' / ');
    parts.push(onlyUnusable
      ? `AVISO JÁ ENVIADO AGORA (automático, por você): ${sent}. A lead só mandou isso. Sua resposta agora é SÓ retomar o próximo passo do roteiro, numa frase curta - NÃO fale do vídeo/áudio/arquivo, NÃO peça desculpas, NÃO peça para reenviar (o aviso já pediu).`
      : `AVISO JÁ ENVIADO AGORA (automático, por você): ${sent}. NÃO repita o aviso nem peça desculpas de novo. Responda o que mais ela disse junto e retome o próximo passo do roteiro.`);
  } else {
    parts.push('VÍDEO DA LEAD: você não assiste vídeos. Se aparecer "[Vídeo enviado pela lead…]", diga com naturalidade que não consegue abrir vídeo por aqui, peça para mandar por texto/áudio/foto e siga o roteiro.');
  }

  return parts.join('\n\n');
}

export async function reply(
  llm: LlmProvider, agent: Agent, history: ChatMessage[], known: Record<string, unknown>,
  isFirstTurn: boolean, phone: string | null, sentMediaIds: string[], now?: Date, progress: RoteiroProgress = {},
  explanation: ExplanationState = 'off', notices: string[] = [], onlyUnusable = false, faqNext: Record<number, FaqPick> = {},
): Promise<{ text: string; requestedMedia: string[]; requestedFaq: number | null; log: CallLog }> {
  const media = availableMedia(agent, sentMediaIds);
  const system = buildResponderPrompt(agent, known, isFirstTurn, phone, media, now, progress, explanation, notices, onlyUnusable, faqNext);
  const model = modelFor(agent, 'responder');
  const faqIdx = Object.keys(faqNext).map(Number);
  const tools = [...(media.length ? [mediaTool(media)] : []), ...(faqIdx.length ? [faqTool(faqIdx)] : [])];

  const res = await llm.chat({ apiKey: agent.apiKey, model, messages: history, system, tools, temperature: TEMPERATURE });

  const ids = new Set(media.map((m) => m.id));
  const requestedMedia = [...new Set(
    res.toolCalls.filter((c) => c.name === 'enviar_midia').map((c) => c.arguments.midia_id).filter((id) => ids.has(id)),
  )];
  const faqCall = res.toolCalls.find((c) => c.name === 'responder_faq' && faqIdx.includes(Number(c.arguments.pergunta)));
  const requestedFaq = faqCall ? Number(faqCall.arguments.pergunta) : null;

  return { text: res.text.trim(), requestedMedia, requestedFaq, log: { step: 'responder', systemPrompt: system, model, raw: res.raw } };
}
