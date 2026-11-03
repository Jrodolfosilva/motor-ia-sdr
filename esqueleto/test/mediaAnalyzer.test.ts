import { describe, expect, it } from 'vitest';
import type { Agent, ContentPart, LlmProvider } from '../src/engine/types';
import { createMediaAnalyzer, parseAnalysis, type MediaFiles } from '../src/engine/agents/mediaAnalyzer';

const agent = {
  id: 'a', apiKey: 'x', model: 'm', models: { vision: 'vl-model' }, provider: 'together',
  kit: { id: 'k', name: 'Escritório X', faq: [], media_library: [], vision_context: { react_to_types: [] } },
  required_documents: [{ key: 'print_ctps', label: 'Print da CTPS', file_types: ['image'], accepted: ['CTPS digital'], request_message: '' }],
} as unknown as Agent;

function files(over: Partial<MediaFiles> & { mime?: string; text?: string } = {}): MediaFiles {
  return {
    read: async () => ({ data: Buffer.from('x'), mime: over.mime ?? 'image/png' }),
    pdfText: async () => over.text ?? '',
    pdfPagesAsPng: async () => [Buffer.from('p1'), Buffer.from('p2')],
    ...over,
  };
}

function llm(reply: string, seen: { parts?: ContentPart[]; model?: string; system?: string } = {}): LlmProvider {
  return {
    async chat({ messages, model, system }) {
      seen.parts = messages[0].content as ContentPart[];
      seen.model = model;
      seen.system = system;
      return { text: reply, toolCalls: [], raw: {} };
    },
  };
}

const JSON_OK = 'ok: {"tipo":"Print CTPS","resumo":"Carteira digital, saída em 12/05/2026","dados":{"Data Saída":"12/05/2026"},"legivel":true} fim';
const msg = (type: 'image' | 'document', body = '') => ({ id: '1', direction: 'inbound' as const, type, body, mediaPath: 'sim/x' });

describe('media analyzer', () => {
  it('foto: manda a imagem pro modelo de visão e normaliza tipo/dados', async () => {
    const seen: any = {};
    const a = await createMediaAnalyzer(llm(JSON_OK, seen), files()).analyze(agent, msg('image', 'tá aqui'));
    expect(seen.model).toBe('vl-model');
    expect(seen.parts.map((p: ContentPart) => p.type)).toEqual(['text', 'image']);
    expect(seen.parts[0].text).toContain('Legenda que ela escreveu: "tá aqui"');
    expect(seen.system).toContain('print_ctps: Print da CTPS');
    expect(a).toMatchObject({ tipo: 'print_ctps', resumo: 'Carteira digital, saída em 12/05/2026', dados: { data_saida: '12/05/2026' }, fonte: 'imagem' });
  });

  it('PDF com texto: manda o texto, sem imagem', async () => {
    const seen: any = {};
    const text = 'Ultrassom obstétrico. Idade gestacional 24 semanas. Data provável do parto 15/02/2027. Exame realizado em 01/11/2026.';
    const a = await createMediaAnalyzer(llm(JSON_OK, seen), files({ mime: 'application/pdf', text })).analyze(agent, msg('document'));
    expect(seen.parts.map((p: ContentPart) => p.type)).toEqual(['text']);
    expect(seen.parts[0].text).toContain('Texto extraído do PDF');
    expect(a?.fonte).toBe('pdf_texto');
  });

  it('PDF escaneado (sem texto): páginas viram imagem', async () => {
    const seen: any = {};
    const a = await createMediaAnalyzer(llm(JSON_OK, seen), files({ mime: 'application/pdf', text: '  ' })).analyze(agent, msg('document'));
    expect(seen.parts.map((p: ContentPart) => p.type)).toEqual(['text', 'image', 'image']);
    expect(a?.fonte).toBe('pdf_imagem');
  });

  it('resposta inválida ou erro → null (motor passa para humano)', async () => {
    expect(await createMediaAnalyzer(llm('não sei'), files()).analyze(agent, msg('image'))).toBeNull();
    const boom: LlmProvider = { chat: async () => { throw new Error('timeout'); } };
    expect(await createMediaAnalyzer(boom, files()).analyze(agent, msg('image'))).toBeNull();
    expect(await createMediaAnalyzer(llm(JSON_OK), files({ read: async () => null })).analyze(agent, msg('image'))).toBeNull();
  });

  it('tipo fora da lista vira "outro"', () => {
    expect(parseAnalysis('{"tipo":"passaporte","resumo":"x"}', ['print_ctps', 'outro'])?.tipo).toBe('outro');
  });
});
