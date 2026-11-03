// MEDIA ANALYZER (visão) - docs/03 §4.
// Lê foto/PDF que o lead mandou e devolve {tipo, resumo, dados, legivel}, que vira a linha
// "[Imagem enviado pela lead - tipo: resumo. Dados lidos: ...]" no histórico.
// Não depende de disco nem de lib de PDF: quem usa injeta `MediaFiles` (adapters/mediaFiles.ts).
import {
  modelFor, type Agent, type CallLog, type ContentPart, type LlmProvider, type MediaAnalysis, type MediaAnalyzerPort, type StoredMessage,
} from '../types';

const TEMPERATURE = 0.1;
const TIMEOUT_MS = 90_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const PDF_TEXT_MIN = 80;
const PDF_TEXT_MAX = 12_000;
const PDF_TEXT_PAGES = 3;
const PDF_IMAGE_PAGES = 2;

/** Tipos genéricos além dos documentos do roteiro. */
const GENERIC_TYPES = ['rg', 'cnh', 'cpf', 'comprovante_residencia', 'extrato_inss', 'print_tela', 'foto_pessoal', 'outro'];

export interface MediaFiles {
  read(path: string): Promise<{ data: Buffer; mime: string } | null>;
  pdfText(data: Buffer, maxPages: number): Promise<string>;
  pdfPagesAsPng(data: Buffer, maxPages: number): Promise<Buffer[]>;
}

export const isPdf = (mime: string) => mime === 'application/pdf';
export const isImage = (mime: string) => /^image\/(png|jpe?g|webp|gif)$/.test(mime);

/** Lista de tipos: documentos do roteiro (keys) + do kit + genéricos. */
export function documentTypes(agent: Agent): string[] {
  const keys = [
    ...agent.required_documents.map((d) => d.key),
    ...(agent.kit.vision_context?.document_types ?? []),
    ...GENERIC_TYPES,
  ];
  return [...new Set(keys.filter(Boolean))];
}

export function buildVisionPrompt(agent: Agent): string {
  const intro = agent.kit.vision_context?.intro
    ?? `Você analisa arquivos (fotos e PDFs) que leads enviam pelo WhatsApp para ${agent.kit.name}.`;
  const docs = agent.required_documents.map((d) => `  - ${d.key}: ${d.label}${d.accepted.length ? ` (serve: ${d.accepted.join(', ')})` : ''}`);
  return [
    `${intro} Responda SOMENTE com um JSON válido, sem nenhum texto fora dele, neste formato:`,
    '{"tipo": "...", "resumo": "...", "dados": {}, "legivel": true}',
    '',
    `- tipo: exatamente um destes: ${documentTypes(agent).join(', ')}.`,
    docs.length ? `  Documentos que o atendimento pede (use a key quando o arquivo for um deles, mesmo que seja só uma das variações aceitas):\n${docs.join('\n')}` : '',
    '- resumo: 1 frase em português dizendo o que é o arquivo e o que ele mostra de relevante (ex: "Carteira de trabalho digital com último vínculo encerrado em 20/10/2025").',
    '- dados: só campos objetivos que estejam legíveis, com chaves em snake_case (ex: nome, empresa, data_admissao, data_saida, semanas_gestacao, data_prevista_parto, data_exame, data_nascimento, cidade, cep). Datas em DD/MM/AAAA. Nunca invente nem complete um dado que não aparece.',
    '- legivel: false só se o arquivo estiver borrado, cortado ou escuro a ponto de não dar pra ler o essencial.',
  ].filter((l) => l !== '').join('\n');
}

const snake = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** Pega do primeiro "{" ao último "}". Exige resumo. */
export function parseAnalysis(text: string, allowed: string[]): Omit<MediaAnalysis, 'fonte' | 'modelo'> | null {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    const j = JSON.parse(text.slice(a, b + 1));
    if (typeof j.resumo !== 'string' || !j.resumo.trim()) return null;
    const tipo = snake(String(j.tipo ?? 'outro'));
    const dados = j.dados && typeof j.dados === 'object' && !Array.isArray(j.dados)
      ? Object.fromEntries(Object.entries(j.dados).map(([k, v]) => [snake(k), v]))
      : {};
    return { tipo: allowed.includes(tipo) ? tipo : 'outro', resumo: j.resumo.trim(), dados, legivel: j.legivel !== false };
  } catch {
    return null;
  }
}

export function createMediaAnalyzer(llm: LlmProvider, files: MediaFiles): MediaAnalyzerPort {
  return {
    supports(m: StoredMessage) {
      return (m.type === 'image' || m.type === 'document') && !!m.mediaPath;
    },

    /** Nunca lança: falha = null (o motor passa a conversa para humano). */
    async analyze(agent: Agent, m: StoredMessage): Promise<(MediaAnalysis & { log?: CallLog }) | null> {
      try {
        const file = await files.read(m.mediaPath!);
        if (!file) return null;
        const caption = m.body.trim();
        const parts: ContentPart[] = [];
        let fonte: string;

        if (isImage(file.mime)) {
          if (file.data.length > MAX_IMAGE_BYTES) return null;
          parts.push({ type: 'text', text: `Foto enviado pela lead.${caption ? ` Legenda que ela escreveu: "${caption}".` : ''}` });
          parts.push({ type: 'image', mime: file.mime, data: file.data.toString('base64') });
          fonte = 'imagem';
        } else if (isPdf(file.mime)) {
          const text = (await files.pdfText(file.data, PDF_TEXT_PAGES)).replace(/\s+/g, ' ').trim();
          const head = `PDF enviado pela lead.${caption ? ` Legenda que ela escreveu: "${caption}".` : ''}`;
          if (text.length >= PDF_TEXT_MIN) {
            parts.push({ type: 'text', text: `${head}\n\nTexto extraído do PDF:\n"""\n${text.slice(0, PDF_TEXT_MAX)}\n"""` });
            fonte = 'pdf_texto';
          } else {
            // PDF escaneado: sem texto → páginas como imagem
            const pages = await files.pdfPagesAsPng(file.data, PDF_IMAGE_PAGES);
            if (!pages.length) return null;
            parts.push({ type: 'text', text: head });
            for (const p of pages) parts.push({ type: 'image', mime: 'image/png', data: p.toString('base64') });
            fonte = 'pdf_imagem';
          }
        } else {
          return null;
        }

        const model = modelFor(agent, 'vision');
        const system = buildVisionPrompt(agent);
        const res = await llm.chat({
          apiKey: agent.apiKey, model, system,
          messages: [{ role: 'user', content: parts }], temperature: TEMPERATURE, timeoutMs: TIMEOUT_MS,
        });
        const parsed = parseAnalysis(res.text, documentTypes(agent));
        const log: CallLog = { step: 'vision', systemPrompt: system, model, raw: res.raw };
        return parsed ? { ...parsed, fonte, modelo: model, log } : null;
      } catch {
        return null;
      }
    },
  };
}
