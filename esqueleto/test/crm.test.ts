import { describe, expect, it } from 'vitest';
import type { Agent, CrmConfig, LlmProvider, LlmResult } from '../src/engine/types';
import { intake, runTurn } from '../src/engine/runTurn';
import { appendUser, buildSimulatorContext, createSession } from '../src/adapters/simulator';

const noVision = { supports: () => false, analyze: async () => null };

const crm: CrmConfig = {
  stages: [
    { id: 'em_atendimento', name: 'Em Atendimento' },
    { id: 'qualificada', name: 'Qualificada' },
    { id: 'coleta', name: 'Coleta de Documentos' },
    { id: 'perdido', name: 'Perdido' },
  ],
  labels: [
    { id: 'ia', name: 'IA atendendo' },
    { id: 'docs', name: 'Docs recebidos' },
    { id: 'elegivel', name: 'Elegível' },
    { id: 'humano', name: 'Precisa humano' },
  ],
  actions: {
    atendimento_iniciado: { move_to: 'em_atendimento', add_labels: ['ia'] },
    perguntas_completas: { move_to: 'qualificada' },
    documento_recebido: { add_labels: ['docs'] },
    'classificado:elegivel': { move_to: 'coleta', add_labels: ['elegivel'], remove_labels: ['ia'] },
    'classificado:empregada': { move_to: 'perdido' },
    passou_para_equipe: { add_labels: ['humano'] },
  },
};

function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: 'a', kit: { id: 'k', name: 'k', faq: [], media_library: [] },
    provider: 'together', apiKey: 'x', model: 'm', system_prompt: 'persona',
    reception: { append_state_presence: false, volume: { after: 'continue', messages: [] }, form: { after: 'continue', messages: [] } },
    crm,
    required_fields: [{ key: 'data_saida_ctps', label: 'Data de saída', question: 'Quando saiu?' }],
    required_documents: [{ key: 'print_ctps', label: 'Print da CTPS', file_types: ['image'], accepted: [], request_message: 'Manda a CTPS?' }],
    classification_labels: [
      { key: 'empregada', label: 'Empregada', description: '', outcome: 'disqualify', rules: [{ field: 'data_saida_ctps', operator: 'contains_any', value: ['ainda trabalhando'] }] },
      { key: 'elegivel', label: 'Elegível', description: '', outcome: 'qualify', rules: [{ field: 'data_saida_ctps', operator: 'months_since_lt', value: 9 }] },
    ],
    handoff_keywords: ['falar com atendente'], max_turns: 20, debounce_seconds: 0, followup_steps: [], log_executions: true,
    ...over,
  };
}

const llm = (extract: Record<string, string>, fonte = 'conversa'): LlmProvider => ({
  async chat({ system }): Promise<LlmResult> {
    if (system?.startsWith('Você é um extrator')) {
      return { text: '', raw: {}, toolCalls: Object.entries(extract).map(([campo, valor]) => ({ name: 'salvar_dado_lead', arguments: { campo, valor, fonte } })) };
    }
    return { text: 'ok', toolCalls: [], raw: {} };
  },
});

describe('CRM / kanban', () => {
  const now = new Date(2026, 10, 2);

  it('move o card e mexe nas etiquetas nos marcos do atendimento', async () => {
    const s = createSession('a', '5511999990000');
    const turn = async (body: string, l: LlmProvider, extra: Partial<Parameters<typeof appendUser>[1]> = {}) => {
      appendUser(s, { type: 'text', body, ...extra });
      await runTurn({ ...buildSimulatorContext(s, agent(), l, noVision), now });
    };

    await turn('oi', llm({}));
    expect(s.crm.stageId).toBe('em_atendimento');
    expect(s.crm.labels).toEqual(['ia']);

    await turn('saí em 01/08/2026', llm({ data_saida_ctps: '01/08/2026' }));
    expect(s.crm.stageId).toBe('qualificada');

    await turn('tá aqui', llm({ print_ctps: 'CTPS recebida' }, 'documento'));
    // documento recebido → +docs; roteiro completo → classificado elegível → coleta, +elegível, −ia
    expect(s.crm.stageId).toBe('coleta');
    expect(s.crm.labels.sort()).toEqual(['docs', 'elegivel']);
    expect(s.messages.filter((m) => m.event?.kind === 'info' && String((m.event as any).message).startsWith('📌 CRM')).length).toBe(4);
  });

  it('cada marco dispara uma vez só', async () => {
    const s = createSession('a', '5511999990000');
    for (const body of ['oi', 'tudo bem?', 'hmm']) {
      appendUser(s, { type: 'text', body });
      await runTurn({ ...buildSimulatorContext(s, agent(), llm({}), noVision), now });
    }
    expect(s.crm.history.filter((h) => h.stageId === 'em_atendimento')).toHaveLength(1);
  });

  it('desqualificação e handoff por palavra-chave também movem', async () => {
    const a = createSession('a', '5511999990000');
    appendUser(a, { type: 'text', body: 'oi' });
    await runTurn({ ...buildSimulatorContext(a, agent(), llm({}), noVision), now });
    appendUser(a, { type: 'text', body: 'ainda trabalho registrada' });
    await runTurn({ ...buildSimulatorContext(a, agent(), llm({ data_saida_ctps: 'ainda trabalhando' }), noVision), now });
    expect(a.crm.stageId).toBe('perdido');

    const b = createSession('a', '5511999990000');
    const ctx = buildSimulatorContext(b, agent(), llm({}), noVision);
    const m = appendUser(b, { type: 'text', body: 'quero falar com atendente' });
    await intake(ctx, m, false);
    expect(b.crm.labels).toContain('humano');
  });

  it('sem CRM configurado: nada acontece', async () => {
    const s = createSession('a', '5511999990000');
    appendUser(s, { type: 'text', body: 'oi' });
    await runTurn({ ...buildSimulatorContext(s, agent({ crm: null }), llm({}), noVision), now });
    expect(s.crm.stageId).toBeNull();
  });

  it('card não volta etapa (forward_only); com a trava desligada, volta', async () => {
    const back = (forward_only: boolean) => agent({
      crm: { ...crm, forward_only, actions: { ...crm.actions, documento_recebido: { move_to: 'em_atendimento' } } },
      classification_labels: [],
    });
    for (const fo of [true, false]) {
      const s = createSession('a', '5511999990000');
      const turn = async (body: string, l: LlmProvider) => {
        appendUser(s, { type: 'text', body });
        await runTurn({ ...buildSimulatorContext(s, back(fo), l, noVision), now });
      };
      await turn('oi', llm({}));
      await turn('saí em 01/08/2026', llm({ data_saida_ctps: '01/08/2026' }));
      expect(s.crm.stageId).toBe('qualificada');
      await turn('tá aqui', llm({ print_ctps: 'CTPS recebida' }, 'documento'));
      expect(s.crm.stageId).toBe(fo ? 'qualificada' : 'em_atendimento');
    }
  });
});
