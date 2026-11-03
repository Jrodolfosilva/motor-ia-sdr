import { modelFor, type Agent, type CallLog, type ChatMessage, type LlmProvider, type PendingStatus, type ToolDef } from '../types';
import { PENDING_LABEL, RequiredFieldsStatus, type RoteiroProgress } from '../rules/requiredFields';
import { isNoiseReply, timeContextLine } from '../rules/misc';
import { elapsedNote } from '../rules/classificationRules';

const TEMPERATURE = 0.1;

export type DataSource = 'conversa' | 'formulario' | 'documento';

const SAVE_TOOL: ToolDef = {
  name: 'salvar_dado_lead',
  description: 'Salva um dado do roteiro (pergunta ou documento) que o lead já informou ou enviou.',
  parameters: {
    type: 'object',
    properties: {
      campo: { type: 'string', description: 'Chave (key) exata da pergunta ou do documento do roteiro.' },
      valor: { type: 'string' },
      fonte: {
        type: 'string',
        enum: ['conversa', 'formulario', 'documento'],
        description: 'De onde veio: "conversa" = o lead disse no chat; "formulario" = só consta nos dados do formulário/anúncio; "documento" = lido num arquivo que o lead enviou.',
      },
    },
    required: ['campo', 'valor', 'fonte'],
  },
};

const CONFIRM_TOOL: ToolDef = {
  name: 'confirmar_dados_formulario',
  description: 'Marca como confirmados pelo lead dados que vieram do formulário (ex: o lead respondeu "sim, isso mesmo" ao resumo dos dados).',
  parameters: {
    type: 'object',
    properties: {
      campos: { type: 'array', items: { type: 'string' }, description: 'Keys das perguntas confirmadas.' },
    },
    required: ['campos'],
  },
};

const PENDING_TOOL: ToolDef = {
  name: 'marcar_pendencia',
  description: 'Registra que o lead NÃO respondeu/enviou um item do roteiro nas mensagens mais recentes, e por quê.',
  parameters: {
    type: 'object',
    properties: {
      campo: { type: 'string', description: 'Key exata da pergunta ou do documento.' },
      situacao: {
        type: 'string',
        enum: ['depois', 'nao_tem', 'recusou'],
        description: '"depois" = vai mandar/responder mais tarde, não consegue AGORA (ex: "tô no trabalho", "mando à noite", "a carteira tá na casa da minha mãe"). "nao_tem" = não tem ou não consegue de jeito nenhum (ex: "não tenho gov.br", "perdi a carteira", "não fiz ultrassom"). "recusou" = não quer informar (ex: "prefiro não falar", "pra que vocês querem isso?" seguido de negativa).',
      },
      detalhe: { type: 'string', description: 'O motivo com as palavras dela, curto.' },
    },
    required: ['campo', 'situacao'],
  },
};

const scalar = (v: unknown) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v));

/** Mensagens do lead depois da última fala da atendente (o que é "novo" neste turno). */
export function latestUserBlock(history: ChatMessage[]): string[] {
  const out: string[] = [];
  for (let i = history.length - 1; i >= 0 && history[i].role === 'user'; i--) {
    const c = history[i].content;
    out.unshift(typeof c === 'string' ? c : c.map((p) => (p.type === 'text' ? p.text : '[imagem]')).join(' '));
  }
  return out;
}

export function buildExtractorPrompt(status: RequiredFieldsStatus, now?: Date, latest: string[] = []): string {
  const qLines = status.fields.map((f) => {
    const v = status.value(f.key);
    const st = status.questionState(f);
    if (st === 'missing') return `- "${f.label}" (key: "${f.key}") - ainda não registrado.`;
    if (st === 'to_confirm') return `- "${f.label}" (key: "${f.key}") - veio do FORMULÁRIO como "${scalar(v)}"${typeof v === 'string' ? elapsedNote(v, now) : ''}, AINDA NÃO CONFIRMADO pelo lead.`;
    return `- "${f.label}" (key: "${f.key}") - já registrado como "${scalar(v)}".`;
  });

  const parts = [
    'Você é um extrator silencioso de dados de uma conversa de onboarding. Não responde ao lead, não faz perguntas, não escreve texto nenhum - sua única saída são chamadas de função.',
    `PERGUNTAS do roteiro. Para cada uma que o lead já tenha informado (mesmo de forma indireta, fora de ordem, ou sem que ninguém tenha perguntado) e que ainda não esteja registrada - ou cujo valor registrado esteja errado -, chame salvar_dado_lead com a key exata e fonte "conversa":\n${qLines.join('\n')}`,
  ];

  if (status.toConfirm().length) {
    parts.push('CONFIRMAÇÃO DO FORMULÁRIO: se o lead confirmou dados que vieram do formulário (ex: respondeu "sim", "isso mesmo", "certinho" a uma mensagem que listava esses dados), chame confirmar_dados_formulario com as keys que foram mostradas e confirmadas. Se ele corrigiu um dado, chame salvar_dado_lead com o valor novo e fonte "conversa" (isso também conta como confirmado). Não confirme dados que não foram mostrados a ele. Atenção a datas de PREVISÃO que já passaram (marcadas "essa data já passou"): um "sim" não confirma a previsão - siga o que a descrição do campo pede (ex: só registrar quando ela informar a data real) e, até lá, não confirme esse campo.');
  }

  if (status.documents.length) {
    const dLines = status.documents.map((d) => {
      const v = status.value(d.key);
      const ok = v !== null && v !== '';
      return ok
        ? `- "${d.label}" (key: "${d.key}") - já recebido: "${scalar(v)}".`
        : `- "${d.label}" (key: "${d.key}") - ainda não recebido. Serve: ${d.accepted.join(', ') || d.label}.`;
    });
    parts.push(`DOCUMENTOS do roteiro. Só registre um documento quando o lead ENVIAR o arquivo (linhas entre colchetes como "[Imagem enviado pela lead - ctps: ...]" ou "[PDF enviado pela lead - ultrassom: ...]"). Salve com salvar_dado_lead, fonte "documento", e valor = resumo curto do que o arquivo mostra (ex: "CTPS recebida - saída em 20/10/2025"). Se o lead disser que o documento não se aplica ao caso dele (ex: nunca trabalhou registrada), salve "não se aplica" com fonte "conversa". Dizer que vai mandar depois NÃO é envio.\n${dLines.join('\n')}`);
    parts.push('Os dados lidos num arquivo (datas, empresa) também valem para as PERGUNTAS do roteiro: salve-os com fonte "documento".');
  }

  if (latest.length) {
    const pend = Object.entries(status.pending)
      .filter(([k]) => status.pendingFor(k))
      .map(([k, p]) => `- ${k}: ${PENDING_LABEL[p.status]} (${p.count}x)${p.detail ? ` - "${p.detail}"` : ''}`);
    parts.push([
      'PENDÊNCIAS: olhe SÓ as mensagens mais recentes do lead (depois da última fala da atendente):',
      latest.map((t) => `> ${t}`).join('\n'),
      'Se nelas o lead disse que não vai responder/enviar AGORA um item que a atendente pediu, chame marcar_pendencia com a key do item e a situação ("depois", "nao_tem" ou "recusou"). Só marque o que aparece nessas mensagens recentes; não remarque coisa antiga. Se o lead enviou ou respondeu o item, use salvar_dado_lead e não marque pendência.',
      'NÃO é pendência (não chame nada): mensagem sem sentido ou letras aleatórias ("asdasd", "bla bla bla", "kkkk"), resposta fora do assunto, "não"/"sim" que responde a uma pergunta de sim/não da atendente (ex: "posso te fazer umas perguntas?", "tá bem?"), ou dúvida do lead. Pendência exige o lead dizer claramente, sobre AQUELE item, que vai depois, que não tem ou que não quer informar. Na dúvida, não marque.',
      pend.length ? `Pendências já registradas:\n${pend.join('\n')}` : '',
    ].filter(Boolean).join('\n'));
  }

  const unmatched = Object.entries(status.unmatched());
  if (unmatched.length) {
    parts.push(
      `Dados que o lead já informou num formulário/anúncio (chaves livres, não seguem o roteiro):\n${unmatched.map(([k, v]) => `- "${k}": "${scalar(v)}"`).join('\n')}\nSe algum deles responde com clareza uma PERGUNTA do roteiro ainda não registrada, salve com fonte "formulario" e valor normalizado (ex: "estou desempregada!" -> "desempregada"; previsão do parto "Abril 2027" -> "04/2027"). Resposta ambígua ou que não corresponde a nenhuma pergunta: ignore.`,
    );
  }

  parts.push(
    timeContextLine(null, now),
    'Datas: salve no formato DD/MM/AAAA sempre que o lead der dia, mês e ano (ou MM/AAAA se der só mês e ano). Datas relativas ("dia 15 de julho desse ano", "mês passado", "ano que vem") viram data completa a partir de hoje.',
    'Se nenhum dado novo, corrigido ou confirmado apareceu na conversa, não chame nenhuma função.',
  );

  return parts.join('\n\n');
}

export interface ExtractResult {
  collected: Record<string, string>;
  /** Fonte de cada campo salvo. */
  sources: Record<string, DataSource>;
  /** Keys de perguntas do formulário confirmadas pelo lead. */
  confirmed: string[];
  /** Itens que o lead disse (agora) que não vai responder/enviar. */
  pending: Record<string, { status: PendingStatus; detail: string | null }>;
  log: CallLog | null;
}

export async function extract(
  llm: LlmProvider, agent: Agent, history: ChatMessage[], known: Record<string, unknown>,
  progress: RoteiroProgress = {}, now?: Date,
): Promise<ExtractResult> {
  const status = new RequiredFieldsStatus(agent.required_fields, known, agent.required_documents, progress);
  if (status.fields.length === 0 && status.documents.length === 0) return { collected: {}, sources: {}, confirmed: [], pending: {}, log: null };

  const latest = latestUserBlock(history);
  const system = buildExtractorPrompt(status, now, latest);
  const model = modelFor(agent, 'extractor');
  const tools = [SAVE_TOOL, ...(status.toConfirm().length ? [CONFIRM_TOOL] : []), ...(latest.length ? [PENDING_TOOL] : [])];
  const res = await llm.chat({ apiKey: agent.apiKey, model, messages: history, system, tools, temperature: TEMPERATURE });

  const validKeys = new Set([...status.fields.map((f) => f.key), ...status.documents.map((d) => d.key)]);
  const collected: Record<string, string> = {};
  const sources: Record<string, DataSource> = {};
  const confirmed: string[] = [];
  const pending: ExtractResult['pending'] = {};
  for (const call of res.toolCalls) {
    if (call.name === 'marcar_pendencia' && validKeys.has(String(call.arguments.campo))) {
      const st = call.arguments.situacao;
      if (st === 'depois' || st === 'nao_tem' || st === 'recusou') {
        pending[String(call.arguments.campo)] = { status: st, detail: call.arguments.detalhe ? String(call.arguments.detalhe) : null };
      }
    }
    if (call.name === 'salvar_dado_lead' && call.arguments.campo) {
      const k = String(call.arguments.campo);
      collected[k] = call.arguments.valor ?? null;
      const src = call.arguments.fonte;
      sources[k] = src === 'formulario' || src === 'documento' ? src : 'conversa';
    }
    if (call.name === 'confirmar_dados_formulario' && Array.isArray(call.arguments.campos)) {
      confirmed.push(...call.arguments.campos.map(String).filter((k: string) => validKeys.has(k)));
    }
  }
  for (const k of Object.keys(collected)) delete pending[k]; // enviou/respondeu → não é pendência
  // "não" solto, "ok", "bla bla", "asdasd": não é adiamento/recusa de item nenhum (regra fixa, o modelo erra)
  if (latest.length && latest.every(isNoiseReply)) for (const k of Object.keys(pending)) delete pending[k];
  return { collected, sources, confirmed, pending, log: { step: 'extractor', systemPrompt: system, model, raw: res.raw } };
}
