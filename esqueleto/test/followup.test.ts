import { describe, expect, it } from 'vitest';
import type { Agent, FollowUpStep } from '../src/engine/types';
import { followupPlan, nextFollowup, renderFollowup, runFollowup } from '../src/engine/followup';
import { buildSimulatorContext, createSession } from '../src/adapters/simulator';

const steps = (...msgs: string[]): FollowUpStep[] =>
  msgs.map((message, i) => ({ step: i + 1, delay_minutes: (i + 1) * 10, message, is_active: true }));

function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: 'a', kit: { id: 'k', name: 'k', faq: [], media_library: [] },
    provider: 'together', apiKey: 'x', model: 'm', system_prompt: 'persona',
    required_fields: [
      { key: 'situacao', label: 'Situação', question: 'Está desempregada?' },
      { key: 'saida', label: 'Saída', question: 'Quando saiu?', followup: steps('saida 1', 'saida 2', 'saida 3') },
    ],
    required_documents: [
      { key: 'ctps', label: 'Carteira', file_types: ['image'], accepted: [], request_message: 'Manda a carteira?', followup: steps('doc 1') },
    ],
    classification_labels: [], handoff_keywords: [], max_turns: 20, debounce_seconds: 0, log_executions: true,
    followup_steps: steps('geral 1', 'geral 2'),
    followup_confirmation: steps('conf 1', 'conf 2', 'conf 3'),
    followup_final_wait_minutes: 60,
    ...over,
  };
}

const state = (over: Record<string, unknown> = {}) => ({ ...createSession('a').state, ...over });

describe('follow-up por etapa', () => {
  it('lead de formulário parado na confirmação usa a sequência de confirmação', () => {
    const p = followupPlan(agent(), { situacao: 'desempregada', saida: '07/12/2025' }, state({ formKeys: ['situacao', 'saida'] }));
    expect(p?.stage).toBe('confirmacao');
    expect(p?.steps.map((s) => s.message)).toEqual(['conf 1', 'conf 2', 'conf 3']);
  });

  it('pergunta sem sequência própria usa a padrão; com sequência própria usa a dela', () => {
    expect(followupPlan(agent(), {}, state())?.steps[0].message).toBe('geral 1');
    const p = followupPlan(agent(), { situacao: 'desempregada' }, state());
    expect(p?.stage).toBe('pergunta:saida');
    expect(p?.steps[0].message).toBe('saida 1');
  });

  it('perguntas ok → documento que falta', () => {
    expect(followupPlan(agent(), { situacao: 'x', saida: 'y' }, state())?.stage).toBe('documento:ctps');
  });

  it('cada passo conta da última mensagem; depois do último vem a espera final', () => {
    const a = agent();
    const known = { situacao: 'desempregada' };
    const d1 = nextFollowup(a, known, state(), 0, 1);
    expect(d1).toMatchObject({ kind: 'step', index: 0, dueAt: 10 });
    const d3 = nextFollowup(a, known, state({ followupStepSent: 2 }), 100, 1);
    expect(d3).toMatchObject({ kind: 'step', index: 2, dueAt: 130 });
    expect(nextFollowup(a, known, state({ followupStepSent: 3 }), 100, 1)).toMatchObject({ kind: 'exhausted', dueAt: 160 });
    expect(nextFollowup(a, known, state({ followupStepSent: 3, followupDone: true }), 100, 1)).toBeNull();
    expect(nextFollowup(a, known, state({ status: 'handed_off' }), 100, 1)).toBeNull();
  });

  it('{nome} vira o primeiro nome (ou some)', () => {
    expect(renderFollowup('Oi, {nome}! Tudo bem?', { nome: 'KELLY silva' })).toBe('Oi, Kelly! Tudo bem?');
    expect(renderFollowup('Oi, {nome}! Tudo bem?', {})).toBe('Oi! Tudo bem?');
  });

  it('envia o passo e, esgotado, marca sem resposta', async () => {
    const a = agent();
    const s = createSession('a', '5511999999999', { situacao: 'desempregada' });
    const ctx = buildSimulatorContext(s, a, { chat: async () => ({ text: '', raw: {} }) } as any, { supports: () => false, analyze: async () => null });
    await runFollowup(ctx, nextFollowup(a, s.customFields, s.state, 0)!);
    expect(s.messages.filter((m) => m.role === 'assistant').map((m) => m.body)).toEqual(['saida 1']);
    expect(s.state.followupStepSent).toBe(1);
    s.state.followupStepSent = 3;
    await runFollowup(ctx, nextFollowup(a, s.customFields, s.state, 0)!);
    expect(s.state.followupDone).toBe(true);
    expect(s.state.crmFired).toContain('sem_resposta');
  });
});
