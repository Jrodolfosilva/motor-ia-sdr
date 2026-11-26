import { describe, expect, it } from 'vitest';
import type { Agent } from '../src/engine/types';
import { buildFormConfirmation } from '../src/engine/formConfirmation';
import { runTurn } from '../src/engine/runTurn';
import { buildSimulatorContext, createSession } from '../src/adapters/simulator';

function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: 'a', kit: { id: 'k', name: 'k', faq: [], media_library: [] },
    provider: 'together', apiKey: 'x', model: 'm', system_prompt: 'persona',
    required_fields: [
      { key: 'situacao_trabalho', label: 'Situação', question: 'Você está desempregada hoje?' },
      { key: 'data_parto', label: 'Parto', question: 'Seu bebê já nasceu?', confirm_label: 'Previsão do parto' },
    ],
    required_documents: [], classification_labels: [], handoff_keywords: [], max_turns: 20, debounce_seconds: 0,
    followup_steps: [], log_executions: true,
    reception: { append_state_presence: false, volume: { after: 'wait', messages: [] }, form: { after: 'continue', messages: [{ kind: 'text', text: 'Olá, mamãe!' }] } },
    form_confirmation: { enabled: true },
    ...over,
  };
}

const known = {
  nome: 'KELLY Silva', situacao_trabalho: 'Estou desempregada!',
  'Você está grávida atualmente?': 'Sim!', data_parto: '12/03/2027', 'E-mail': 'x@y.com',
};

describe('confirmação do formulário em mensagem pronta', () => {
  it('lista pergunta em negrito e resposta, na ordem do formulário, sem nome/e-mail', () => {
    expect(buildFormConfirmation(agent(), known)).toBe([
      'Pode confirmar se os dados estão corretos?',
      '*Você está desempregada hoje:* Estou desempregada!\n*Você está grávida atualmente:* Sim!\n*Previsão do parto:* 12/03/2027',
    ].join('\n\n'));
    expect(buildFormConfirmation(agent({ form_confirmation: { enabled: false } }), known)).toBeNull();
  });

  it('abertura ativa: recepção + confirmação, sem chamar a IA, e espera a resposta', async () => {
    const s = createSession('a', '5511999990000', known);
    let calls = 0;
    const llm = { async chat() { calls++; return { text: 'não devia', toolCalls: [], raw: {} }; } };
    await runTurn(buildSimulatorContext(s, agent(), llm as any, { supports: () => false, analyze: async () => null }));
    const out = s.messages.filter((m) => m.role === 'assistant').map((m) => m.body);
    expect(out[0]).toBe('Olá, mamãe!');
    expect(out[1]).toContain('*Você está desempregada hoje:* Estou desempregada!');
    expect(out).toHaveLength(2);
    expect(calls).toBe(0);
  });
});
