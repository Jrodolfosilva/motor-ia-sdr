import { describe, expect, it } from 'vitest';
import type { Agent, LlmProvider, LlmResult } from '../src/engine/types';
import { intake, runTurn } from '../src/engine/runTurn';
import { appendUser, buildSimulatorContext, createSession } from '../src/adapters/simulator';

const noVision = { supports: () => false, analyze: async () => null };

function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: 'a', kit: { id: 'k', name: 'k', faq: [], media_library: [] },
    provider: 'together', apiKey: 'x', model: 'm', system_prompt: 'persona',
    greeting_example: 'Olá! Sou a Bella.', consent_message: 'Posso fazer umas perguntas?',
    required_fields: [{ key: 'data_saida_ctps', label: 'Data de saída', question: 'Quando saiu?' }],
    required_documents: [],
    classification_labels: [
      { key: 'elegivel', label: 'Elegível', description: '', outcome: 'qualify',
        rules: [{ field: 'data_saida_ctps', operator: 'months_since_lt', value: 9 }] },
    ],
    handoff_message: 'Agora {atendente} segue com você.', fallback_message: 'Instabilidade',
    handoff_keywords: ['falar com atendente'], max_turns: 20, debounce_seconds: 0,
    followup_steps: [], log_executions: true, ...over,
  };
}

/** LLM fake: responde por step, olhando o system prompt. */
function fakeLlm(script: {
  extractor?: Record<string, string>; fonte?: string; confirm?: string[]; responder?: string;
  pending?: Record<string, string>;
}): LlmProvider {
  return {
    async chat({ system }): Promise<LlmResult> {
      if (system?.startsWith('Você é um extrator')) {
        const toolCalls = Object.entries(script.extractor ?? {}).map(([campo, valor]) => ({ name: 'salvar_dado_lead', arguments: { campo, valor, fonte: script.fonte ?? 'conversa' } }));
        if (script.confirm) toolCalls.push({ name: 'confirmar_dados_formulario', arguments: { campos: script.confirm } as any });
        for (const [campo, situacao] of Object.entries(script.pending ?? {})) toolCalls.push({ name: 'marcar_pendencia', arguments: { campo, situacao, detalhe: 'teste' } as any });
        return { text: '', raw: {}, toolCalls };
      }
      return { text: script.responder ?? 'Quando você saiu da empresa?', toolCalls: [], raw: {} };
    },
  };
}

const texts = (s: ReturnType<typeof createSession>) => s.messages.filter((m) => m.role === 'assistant').map((m) => m.body);

describe('runTurn', () => {
  it('lead frio: saudação + consentimento, IA calada', async () => {
    const s = createSession('a', '5571999990000');
    const ctx = buildSimulatorContext(s, agent(), fakeLlm({}), noVision);
    appendUser(s, { type: 'text', body: 'oi' });
    await runTurn(ctx);
    expect(texts(s)).toEqual(['Olá! Sou a Bella. Atendemos em todo o Brasil, com forte presença na Bahia.', 'Posso fazer umas perguntas?']);
  });

  it('lead de formulário sem mensagem ("Iniciar"): IA abre a conversa', async () => {
    const s = createSession('a', '5511999990000', { data_saida_ctps: '01/08/2026' });
    let lastUser = '';
    const llm = fakeLlm({ responder: 'Vi que você saiu em agosto, confere?' });
    const spy: LlmProvider = {
      async chat(args) {
        const msgs = (args as any).messages ?? [];
        lastUser = String([...msgs].reverse().find((m: any) => m.role === 'user')?.content ?? '');
        return llm.chat(args);
      },
    };
    await runTurn(buildSimulatorContext(s, agent(), spy, noVision));
    expect(texts(s)).toContain('Vi que você saiu em agosto, confere?');
    expect(lastUser).toContain('ainda não mandou mensagem');
  });

  it('lead frio sem mensagem: nada acontece', async () => {
    const s = createSession('a');
    await runTurn(buildSimulatorContext(s, agent({ greeting_example: undefined, consent_message: undefined }), fakeLlm({}), noVision));
    expect(texts(s)).toEqual([]);
  });

  it('extrai, classifica por regra e faz handoff', async () => {
    const s = createSession('a');
    const now = new Date(2026, 10, 2);
    const ctx = { ...buildSimulatorContext(s, agent(), fakeLlm({ extractor: { data_saida_ctps: '01/08/2026' } }), noVision), now };
    appendUser(s, { type: 'text', body: 'oi' });
    await runTurn(ctx);
    appendUser(s, { type: 'text', body: 'sim, saí em 01/08/2026' });
    await runTurn(ctx);
    expect(s.customFields.data_saida_ctps).toBe('01/08/2026');
    expect(s.state.status).toBe('handed_off');
    expect(s.state.classification).toBe('elegivel');
    expect(texts(s).at(-1)).toBe('Agora nossa equipe segue com você.');
  });

  it('balões e lead quente sem consentimento', async () => {
    const s = createSession('a', '5511999990000', { 'Você está grávida': 'sim' });
    const ctx = buildSimulatorContext(s, agent(), fakeLlm({ responder: 'Oi Maria!\n\nQuando você saiu?' }), noVision);
    appendUser(s, { type: 'text', body: 'oi' });
    await runTurn(ctx);
    expect(texts(s).slice(1)).toEqual(['Oi Maria!', 'Quando você saiu?']);
  });

  it('keyword de humano e mídia ilegível fazem handoff no intake', async () => {
    const s = createSession('a');
    const ctx = buildSimulatorContext(s, agent(), fakeLlm({}), noVision);
    const m = appendUser(s, { type: 'text', body: 'quero FALAR COM ATENDENTE' });
    expect(await intake(ctx, m, false)).toBe('handed_off');
    expect(s.state.handoffReason).toBe('handoff_keyword');
  });

  it('erro do provider → fallback', async () => {
    const s = createSession('a', '5511999990000', { x: 'y' });
    const llm: LlmProvider = { chat: async () => { throw new Error('boom'); } };
    const ctx = buildSimulatorContext(s, agent(), llm, noVision);
    appendUser(s, { type: 'text', body: 'oi' });
    await runTurn(ctx);
    expect(texts(s).at(-1)).toBe('Instabilidade');
  });

  describe('lead de formulário: confirmar + documentos', () => {
    const now = new Date(2026, 10, 2);
    const withDoc = () => agent({
      required_documents: [{
        key: 'print_ctps', label: 'Print da CTPS', file_types: ['image', 'pdf'], accepted: ['CTPS digital'],
        how_to_get: 'App Carteira de Trabalho Digital > Contratos', request_message: 'Me manda o print da carteira?',
        validates: ['data_saida_ctps'],
      }],
    });

    it('dado do form não basta: sem confirmação e sem documento, não classifica', async () => {
      const s = createSession('a', '5511999990000', { data_saida_ctps: '01/08/2026' });
      const ctx = { ...buildSimulatorContext(s, withDoc(), fakeLlm({}), noVision), now };
      appendUser(s, { type: 'text', body: 'oi' });
      await runTurn(ctx);
      expect(s.state.formKeys).toEqual(['data_saida_ctps']);
      expect(s.state.status).toBe('active');
    });

    it('confirma o dado, manda o documento e só então classifica', async () => {
      const s = createSession('a', '5511999990000', { data_saida_ctps: '01/08/2026' });
      const base = buildSimulatorContext(s, withDoc(), fakeLlm({ confirm: ['data_saida_ctps'] }), noVision);
      appendUser(s, { type: 'text', body: 'sim, isso mesmo' });
      await runTurn({ ...base, now });
      expect(s.state.confirmedKeys).toEqual(['data_saida_ctps']);
      expect(s.state.status).toBe('active'); // falta o documento

      const docCtx = { ...buildSimulatorContext(s, withDoc(), fakeLlm({ extractor: { print_ctps: 'CTPS - saída 01/08/2026' }, fonte: 'documento' }), noVision), now };
      const m = appendUser(s, { type: 'image', body: '', mediaPath: 'simulado', aiAnalysis: { tipo: 'print_ctps', resumo: 'CTPS digital, saída em 01/08/2026', dados: {}, legivel: true } });
      expect(await intake(docCtx, m, false)).toBe('schedule');
      await runTurn(docCtx);
      expect(s.state.status).toBe('handed_off');
      expect(s.state.classification).toBe('elegivel');
    });

    it('documento que valida a pergunta dispensa a confirmação por texto', async () => {
      const s = createSession('a', '5511999990000', { data_saida_ctps: '01/08/2026', print_ctps: 'CTPS ok' });
      const ctx = { ...buildSimulatorContext(s, withDoc(), fakeLlm({}), noVision), now };
      appendUser(s, { type: 'text', body: 'oi' });
      await runTurn(ctx);
      expect(s.state.status).toBe('handed_off');
    });
  });

  describe('ritmo dos balões e interrupção', () => {
    it('pausa antes de cada balão com "digitando…"', async () => {
      const s = createSession('a', '5511999990000', { x: 'y' });
      const waits: number[] = [];
      const ctx = { ...buildSimulatorContext(s, agent(), fakeLlm({ responder: 'Oi!\n\nQuando você saiu da empresa com carteira assinada?' }), noVision), pacing: { sleep: async (ms: number) => { waits.push(ms); } } };
      appendUser(s, { type: 'text', body: 'oi' });
      await runTurn(ctx);
      expect(texts(s).slice(1)).toEqual(['Oi!', 'Quando você saiu da empresa com carteira assinada?']);
      expect(waits.length).toBe(3); // saudação + 2 balões
      expect(waits.every((ms) => ms >= 2000 && ms <= 6000)).toBe(true);
      expect(s.typing).toBe(false);
    });

    it('lead escreve no meio: balões restantes são descartados', async () => {
      const s = createSession('a', '5511999990000', { x: 'y' });
      let n = 0;
      const ctx = {
        ...buildSimulatorContext(s, agent(), fakeLlm({ responder: 'Um\n\nDois\n\nTrês' }), noVision),
        pacing: { sleep: async () => { if (++n === 3) appendUser(s, { type: 'text', body: 'espera, errei' }); } },
      };
      appendUser(s, { type: 'text', body: 'oi' });
      await runTurn(ctx);
      expect(texts(s).slice(1)).toEqual(['Um']); // "Dois" e "Três" não saem
      expect(s.messages.some((m) => m.event?.kind === 'info' && /2 balões descartados/.test(String((m.event as any).message)))).toBe(true);
    });
  });

  describe('pendências: depois / não tem / recusou', () => {
    const now = new Date(2026, 10, 2);
    const withDoc = () => agent({
      required_documents: [{
        key: 'print_ctps', label: 'Print da CTPS', file_types: ['image'], accepted: ['CTPS digital', 'carteira física'],
        how_to_get: 'App Carteira de Trabalho Digital', request_message: 'Me manda o print?', validates: [],
      }],
    });

    it('"não tem" na 1ª vez não libera; na 2ª libera e classifica com pendência na nota', async () => {
      const s = createSession('a', '5511999990000');
      const turn = async (llm: LlmProvider, body: string) => {
        appendUser(s, { type: 'text', body });
        await runTurn({ ...buildSimulatorContext(s, withDoc(), llm, noVision), now });
      };
      await turn(fakeLlm({}), 'oi');
      await turn(fakeLlm({ extractor: { data_saida_ctps: '01/08/2026' }, pending: { print_ctps: 'nao_tem' } }), 'saí em 01/08/2026 mas não tenho a carteira');
      expect(s.state.pending.print_ctps).toMatchObject({ status: 'nao_tem', count: 1 });
      expect(s.state.status).toBe('active');

      await turn(fakeLlm({ pending: { print_ctps: 'nao_tem' } }), 'não tenho nenhum dos dois');
      expect(s.state.pending.print_ctps.count).toBe(2);
      expect(s.state.status).toBe('handed_off');
      const note = s.messages.find((m) => m.type === 'internal_note' && m.body.includes('Pendências'));
      expect(note?.body).toContain('Print da CTPS: não tem / não consegue');
    });

    it('recusou libera na 1ª; documento enviado depois apaga a pendência', async () => {
      const s = createSession('a', '5511999990000');
      appendUser(s, { type: 'text', body: 'oi' });
      await runTurn({ ...buildSimulatorContext(s, withDoc(), fakeLlm({}), noVision), now }); // saudação + consentimento
      appendUser(s, { type: 'text', body: 'prefiro não mandar' });
      await runTurn({ ...buildSimulatorContext(s, agent({ ...withDoc(), classification_labels: [] }), fakeLlm({ pending: { print_ctps: 'recusou' } }), noVision), now });
      expect(s.state.pending.print_ctps.status).toBe('recusou');

      appendUser(s, { type: 'text', body: 'ah, toma aqui' });
      await runTurn({ ...buildSimulatorContext(s, agent({ ...withDoc(), classification_labels: [] }), fakeLlm({ extractor: { print_ctps: 'CTPS ok' }, fonte: 'documento' }), noVision), now });
      expect(s.state.pending.print_ctps).toBeUndefined();
    });
  });

  describe('recepção por cenário (texto / áudio / vídeo)', () => {
    const reception = {
      append_state_presence: false,
      volume: { after: 'wait' as const, messages: [
        { kind: 'video' as const, media: { path: 'media/oi.mp4' }, transcript: 'Oi, sou a Bella do escritório X' },
        { kind: 'text' as const, text: 'Vou te fazer umas perguntas rapidinhas, tá?' },
      ] },
      form: { after: 'continue' as const, messages: [
        { kind: 'text' as const, text: 'Oi! Sou a Bella.' },
        { kind: 'audio' as const, media: { path: 'media/form.ogg' }, transcript: 'Vi que você preencheu nosso formulário' },
      ] },
    };

    it('mensagem desligada (enabled=false) não sai, mesmo com arquivo', async () => {
      const s = createSession('a', '5511999990000');
      const off = { ...reception, volume: { after: 'wait' as const, messages: [{ ...reception.volume.messages[0], enabled: false }, reception.volume.messages[1]] } };
      appendUser(s, { type: 'text', body: 'oi' });
      await runTurn(buildSimulatorContext(s, agent({ reception: off }), fakeLlm({}), noVision));
      expect(s.messages.filter((m) => m.role === 'assistant').map((m) => m.type)).toEqual(['text']);
    });

    it('lead de volume: vídeo + texto e espera o lead', async () => {
      const s = createSession('a', '5511999990000');
      const ctx = buildSimulatorContext(s, agent({ reception }), fakeLlm({ responder: 'NÃO DEVIA' }), noVision);
      appendUser(s, { type: 'text', body: 'oi' });
      await runTurn(ctx);
      const out = s.messages.filter((m) => m.role === 'assistant');
      expect(out.map((m) => m.type)).toEqual(['video', 'text']);
      expect(out[0].mediaPath).toBe('media/oi.mp4');
      expect(texts(s)).not.toContain('NÃO DEVIA');
    });

    it('lead de formulário: texto + áudio e a IA segue no mesmo turno sabendo o que o áudio disse', async () => {
      const s = createSession('a', '5511999990000', { data_saida_ctps: '01/08/2026' });
      let responderSystem = '';
      let responderHistory: unknown[] = [];
      const llm: LlmProvider = {
        async chat({ system, messages }) {
          if (system?.startsWith('Você é um extrator')) return { text: '', toolCalls: [], raw: {} };
          responderSystem = system ?? '';
          responderHistory = messages;
          return { text: 'Vi aqui que você saiu em 01/08/2026, confere?', toolCalls: [], raw: {} };
        },
      };
      appendUser(s, { type: 'text', body: 'oi' });
      await runTurn(buildSimulatorContext(s, agent({ reception }), llm, noVision));
      const out = s.messages.filter((m) => m.role === 'assistant');
      expect(out.map((m) => m.type)).toEqual(['text', 'audio', 'text']);
      expect(out[0].body).toBe('Oi! Sou a Bella.');
      expect(responderSystem).toContain('RECEPÇÃO JÁ ENVIADA');
      expect(responderSystem).toContain('Vi que você preencheu nosso formulário');

      // no turno seguinte, o áudio aparece no histórico pela transcrição
      appendUser(s, { type: 'text', body: 'confere sim' });
      await runTurn(buildSimulatorContext(s, agent({ reception }), llm, noVision));
      expect(JSON.stringify(responderHistory)).toContain('Áudio enviado pela atendente: \\"Vi que você preencheu nosso formulário\\"');
    });
  });

  it('lead frio abre a conversa com uma foto: arquivo é lido mesmo com a recepção esperando', async () => {
    const s = createSession('a', '5511999990000');
    const vision = { supports: () => true, analyze: async () => ({ tipo: 'outro', resumo: 'print de conversa', dados: {}, legivel: true }) };
    const ctx = buildSimulatorContext(s, agent(), fakeLlm({}), vision);
    const m = appendUser(s, { type: 'image', body: '', mediaPath: 'sim/x.png' });
    expect(await intake(ctx, m, true)).toBe('schedule');
    await runTurn(ctx);
    expect(s.messages.find((x) => x.id === m.id)?.aiAnalysis).toMatchObject({ resumo: 'print de conversa' });
    expect(texts(s)).toEqual(['Olá! Sou a Bella. Atendemos em todo o Brasil, com forte presença em São Paulo.', 'Posso fazer umas perguntas?']);
  });

  describe('desqualificação antecipada (empregada não é público)', () => {
    const empregada = {
      key: 'empregada', label: 'Empregada', description: 'Trabalha registrada hoje', outcome: 'disqualify' as const,
      disqualify_message: 'A empresa paga automaticamente.',
      rules: [{ field: 'situacao_trabalho', operator: 'contains_any' as const, value: ['empregada registrada', 'carteira assinada'] }],
    };
    const ag = () => agent({
      required_fields: [
        { key: 'situacao_trabalho', label: 'Situação', question: '?' },
        { key: 'data_saida_ctps', label: 'Data de saída', question: 'Quando saiu?' },
      ],
      classification_labels: [empregada, ...agent().classification_labels],
    });

    it('lead frio diz que trabalha registrada: desqualifica na hora, sem completar o roteiro', async () => {
      const s = createSession('a', '5511999990000');
      appendUser(s, { type: 'text', body: 'oi' });
      await runTurn(buildSimulatorContext(s, ag(), fakeLlm({}), noVision));
      appendUser(s, { type: 'text', body: 'trabalho de carteira assinada' });
      await runTurn(buildSimulatorContext(s, ag(), fakeLlm({ extractor: { situacao_trabalho: 'empregada registrada' } }), noVision));
      expect(s.state.status).toBe('handed_off');
      expect(s.state.classification).toBe('empregada');
      expect(texts(s).at(-1)).toBe('A empresa paga automaticamente.');
    });

    it('"desempregada" não casa com "empregada registrada"', async () => {
      const s = createSession('a', '5511999990000');
      appendUser(s, { type: 'text', body: 'oi' });
      await runTurn(buildSimulatorContext(s, ag(), fakeLlm({}), noVision));
      appendUser(s, { type: 'text', body: 'tô desempregada' });
      await runTurn(buildSimulatorContext(s, ag(), fakeLlm({ extractor: { situacao_trabalho: 'desempregada' } }), noVision));
      expect(s.state.status).toBe('active');
    });

    it('formulário diz empregada mas ela ainda não confirmou: não desqualifica até confirmar', async () => {
      const s = createSession('a', '5511999990000', { situacao_trabalho: 'empregada registrada' });
      appendUser(s, { type: 'text', body: 'oi' });
      await runTurn(buildSimulatorContext(s, ag(), fakeLlm({}), noVision));
      expect(s.state.status).toBe('active');

      appendUser(s, { type: 'text', body: 'isso, trabalho registrada' });
      await runTurn(buildSimulatorContext(s, ag(), fakeLlm({ confirm: ['situacao_trabalho'] }), noVision));
      expect(s.state.classification).toBe('empregada');
    });
  });
});
