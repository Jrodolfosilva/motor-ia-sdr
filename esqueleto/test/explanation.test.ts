import { describe, expect, it } from 'vitest';
import type { Agent, ExplanationModule, LlmProvider, LlmResult } from '../src/engine/types';
import { runTurn } from '../src/engine/runTurn';
import { elapsedNote } from '../src/engine/agents/responder';
import { appendUser, buildSimulatorContext, createSession } from '../src/adapters/simulator';

const noVision = { supports: () => false, analyze: async () => null };

const explanation = (over: Partial<ExplanationModule> = {}): ExplanationModule => ({
  enabled: true,
  after: 'continue',
  trigger_fields: ['situacao_trabalho', 'data_saida_ctps'],
  messages: [
    { kind: 'text', text: 'Funciona assim: o benefício é calculado pelas suas contribuições.' },
    { kind: 'audio', media: { path: 'media/explica.ogg' }, transcript: 'O valor costuma ficar entre 6 e 14 mil.' },
  ],
  ...over,
});

function agent(ex: ExplanationModule | null): Agent {
  return {
    id: 'a', kit: { id: 'k', name: 'k', faq: [], media_library: [] },
    provider: 'together', apiKey: 'x', model: 'm', system_prompt: 'persona',
    reception: { append_state_presence: false, volume: { after: 'continue', messages: [] }, form: { after: 'continue', messages: [] } },
    explanation: ex,
    required_fields: [
      { key: 'situacao_trabalho', label: 'Situação', question: '?' },
      { key: 'data_saida_ctps', label: 'Data de saída', question: 'Quando saiu?' },
      { key: 'email', label: 'E-mail', question: 'E-mail?' },
    ],
    required_documents: [{ key: 'print_ctps', label: 'Print da CTPS', file_types: ['image'], accepted: [], request_message: 'Manda a CTPS?' }],
    classification_labels: [], handoff_keywords: [], max_turns: 20, debounce_seconds: 0, followup_steps: [], log_executions: true,
  };
}

/** LLM fake: extrator salva o que mandarem; responder devolve texto e guarda o prompt. */
function llm(extract: Record<string, string>, seen: { system?: string } = {}, reply = 'Me manda o print da CTPS?'): LlmProvider {
  return {
    async chat({ system }): Promise<LlmResult> {
      if (system?.startsWith('Você é um extrator')) {
        return { text: '', raw: {}, toolCalls: Object.entries(extract).map(([campo, valor]) => ({ name: 'salvar_dado_lead', arguments: { campo, valor, fonte: 'conversa' } })) };
      }
      seen.system = system;
      return { text: reply, toolCalls: [], raw: {} };
    },
  };
}

const outTypes = (s: ReturnType<typeof createSession>) => s.messages.filter((m) => m.role === 'assistant').map((m) => m.type);

describe('módulo de explicação', () => {
  it('antes das perguntas-gatilho: não envia e proíbe pitch/documentos no prompt', async () => {
    const s = createSession('a', '5511999990000');
    const seen: { system?: string } = {};
    appendUser(s, { type: 'text', body: 'tô desempregada' });
    await runTurn(buildSimulatorContext(s, agent(explanation()), llm({ situacao_trabalho: 'desempregada' }, seen), noVision));
    expect(s.state.explanationSent).toBeFalsy();
    expect(outTypes(s)).toEqual(['text']);
    expect(seen.system).toContain('NÃO peça documentos');
  });

  it('quando as perguntas-gatilho fecham: envia texto + áudio uma vez e a IA já pede o documento', async () => {
    const s = createSession('a', '5511999990000');
    const seen: { system?: string } = {};
    appendUser(s, { type: 'text', body: 'desempregada, saí em 01/08/2026' });
    await runTurn(buildSimulatorContext(s, agent(explanation()), llm({ situacao_trabalho: 'desempregada', data_saida_ctps: '01/08/2026' }, seen), noVision));
    expect(s.state.explanationSent).toBe(true);
    expect(outTypes(s)).toEqual(['text', 'audio', 'text']);
    expect(seen.system).toContain('EXPLICAÇÃO VAI SAIR AGORA');
    expect(seen.system).toContain('O valor costuma ficar entre 6 e 14 mil');
    expect(seen.system).toContain('que termina em: [Áudio gravado pela atendente: "O valor costuma ficar entre 6 e 14 mil."]');
    expect(seen.system).toContain('Print da CTPS');

    // turno seguinte: não repete
    appendUser(s, { type: 'text', body: 'ok' });
    await runTurn(buildSimulatorContext(s, agent(explanation()), llm({}, seen), noVision));
    expect(outTypes(s)).toEqual(['text', 'audio', 'text', 'text']);
    expect(seen.system).toContain('já enviada antes');
  });

  it('after = wait: envia e espera o lead (sem resposta da IA no mesmo turno)', async () => {
    const s = createSession('a', '5511999990000');
    appendUser(s, { type: 'text', body: 'desempregada, saí em 01/08/2026' });
    await runTurn(buildSimulatorContext(s, agent(explanation({ after: 'wait' })), llm({ situacao_trabalho: 'desempregada', data_saida_ctps: '01/08/2026' }), noVision));
    expect(outTypes(s)).toEqual(['text', 'audio']);
  });

  it('desligado: comportamento antigo (IA explica sozinha)', async () => {
    const s = createSession('a', '5511999990000');
    const seen: { system?: string } = {};
    appendUser(s, { type: 'text', body: 'desempregada, saí em 01/08/2026' });
    await runTurn(buildSimulatorContext(s, agent(explanation({ enabled: false })), llm({ situacao_trabalho: 'desempregada', data_saida_ctps: '01/08/2026' }, seen), noVision));
    expect(outTypes(s)).toEqual(['text']);
    expect(seen.system).not.toContain('MÓDULO DE EXPLICAÇÃO');
  });

  it('datas que já passaram ganham aviso (previsão do parto vencida)', () => {
    const now = new Date(2026, 10, 2);
    expect(elapsedNote('20/10/2026', now)).toBe(' (essa data já passou - há 13 dias)');
    expect(elapsedNote('06/06/2026', now)).toBe(' (essa data já passou - há 4 meses)');
    expect(elapsedNote('10/07/2027', now)).toBe('');
    expect(elapsedNote('02/11/2026', now)).toBe(' (é hoje)');
  });

  it('reação vem ANTES da explicação e o pedido do documento DEPOIS', async () => {
    const s = createSession('a', '5511999990000');
    appendUser(s, { type: 'text', body: 'desempregada, saí em 01/08/2026, e o bebê nasceu ontem!' });
    const reply = 'Parabéns pelo bebê! 🥳\n[[EXPLICACAO]]\nPra confirmar sua data de saída, me manda o print da CTPS?';
    await runTurn(buildSimulatorContext(s, agent(explanation()), llm({ situacao_trabalho: 'desempregada', data_saida_ctps: '01/08/2026' }, {}, reply), noVision));
    const out = s.messages.filter((m) => m.role === 'assistant').map((m) => m.body || m.type);
    expect(out).toEqual([
      'Parabéns pelo bebê! 🥳',
      'Funciona assim: o benefício é calculado pelas suas contribuições.',
      'audio',
      'Pra confirmar sua data de saída, me manda o print da CTPS?',
    ]);
    expect(s.state.explanationSent).toBe(true);
  });

  it('lead escreve durante a reação: explicação não sai e fica para o próximo turno', async () => {
    const s = createSession('a', '5511999990000');
    appendUser(s, { type: 'text', body: 'desempregada, saí em 01/08/2026' });
    const ctx = {
      ...buildSimulatorContext(s, agent(explanation()), llm({ situacao_trabalho: 'desempregada', data_saida_ctps: '01/08/2026' }, {}, 'Que bom!\n[[EXPLICACAO]]\nMe manda a CTPS?'), noVision),
      pacing: { sleep: async () => { appendUser(s, { type: 'text', body: 'espera' }); } },
    };
    await runTurn(ctx);
    expect(s.state.explanationSent).toBeFalsy();
    expect(s.messages.filter((m) => m.role === 'assistant')).toHaveLength(0);
  });
});
