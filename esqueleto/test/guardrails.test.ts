import { describe, expect, it } from 'vitest';
import type { Agent, Guardrails, LlmProvider, LlmResult } from '../src/engine/types';
import { intake, runTurn } from '../src/engine/runTurn';
import { appendUser, buildSimulatorContext, createSession } from '../src/adapters/simulator';

const noVision = { supports: () => false, analyze: async () => null };
const failVision = { supports: () => true, analyze: async () => null };

const guard = (over: Partial<Guardrails> = {}): Guardrails => ({
  rules: ['Assunto fora do escopo: diga que aqui você cuida só do salário-maternidade e volte à pergunta pendente.'],
  video_reply: 'Não consigo assistir vídeos por aqui.',
  audio_fail_reply: 'Não entendi seu áudio, pode repetir?',
  file_fail_reply: 'Não consegui abrir o arquivo, manda de novo?',
  file_fail_action: 'reply',
  ...over,
});

function agent(g: Guardrails | null): Agent {
  return {
    id: 'a', kit: { id: 'k', name: 'k', faq: [], media_library: [] },
    provider: 'together', apiKey: 'x', model: 'm', system_prompt: 'persona',
    reception: { append_state_presence: false, volume: { after: 'continue', messages: [] }, form: { after: 'continue', messages: [] } },
    guardrails: g,
    required_fields: [{ key: 'data_saida_ctps', label: 'Data de saída', question: 'Quando saiu?' }],
    required_documents: [], classification_labels: [], handoff_keywords: [], max_turns: 20, debounce_seconds: 0, followup_steps: [], log_executions: true,
  };
}

function llm(seen: { system?: string } = {}): LlmProvider {
  return {
    async chat({ system }): Promise<LlmResult> {
      if (system?.startsWith('Você é um extrator')) return { text: '', toolCalls: [], raw: {} };
      seen.system = system;
      return { text: 'E quando você saiu da empresa?', toolCalls: [], raw: {} };
    },
  };
}

const texts = (s: ReturnType<typeof createSession>) => s.messages.filter((m) => m.role === 'assistant').map((m) => m.body);

describe('conduta e limites', () => {
  it('regras de conduta entram no prompt do responder', async () => {
    const s = createSession('a', '5511999990000');
    const seen: { system?: string } = {};
    appendUser(s, { type: 'text', body: 'qual seu time de futebol?' });
    await runTurn(buildSimulatorContext(s, agent(guard()), llm(seen), noVision));
    expect(seen.system).toContain('REGRAS DE CONDUTA');
    expect(seen.system).toContain('cuida só do salário-maternidade');
  });

  it('vídeo: aviso fixo e a IA retoma o roteiro', async () => {
    const s = createSession('a', '5511999990000');
    const seen: { system?: string } = {};
    const ctx = buildSimulatorContext(s, agent(guard()), llm(seen), noVision);
    const m = appendUser(s, { type: 'video', body: '', mediaPath: 'sim/v.mp4' });
    expect(await intake(ctx, m, true)).toBe('schedule');
    await runTurn(ctx);
    expect(texts(s)).toEqual(['Não consigo assistir vídeos por aqui.', 'E quando você saiu da empresa?']);
    expect(seen.system).toContain('AVISO JÁ ENVIADO AGORA');
  });

  it('áudio que não deu pra transcrever: aviso e segue (não passa pra humano)', async () => {
    const s = createSession('a', '5511999990000');
    const ctx = buildSimulatorContext(s, agent(guard()), llm(), noVision);
    const m = appendUser(s, { type: 'audio', body: '', transcript: null });
    expect(await intake(ctx, m, true)).toBe('schedule');
    await runTurn(ctx);
    expect(s.state.status).toBe('active');
    expect(texts(s)[0]).toBe('Não entendi seu áudio, pode repetir?');
  });

  it('arquivo ilegível com ação "reply": aviso e segue', async () => {
    const s = createSession('a', '5511999990000');
    const ctx = buildSimulatorContext(s, agent(guard()), llm(), failVision);
    const m = appendUser(s, { type: 'image', body: '', mediaPath: 'sim/x.png' });
    expect(await intake(ctx, m, true)).toBe('schedule');
    await runTurn(ctx);
    expect(s.state.status).toBe('active');
    expect(texts(s)[0]).toBe('Não consegui abrir o arquivo, manda de novo?');
  });

  it('arquivo ilegível com ação "handoff": passa para humano (comportamento antigo)', async () => {
    const s = createSession('a', '5511999990000');
    const ctx = buildSimulatorContext(s, agent(guard({ file_fail_action: 'handoff' })), llm(), failVision);
    appendUser(s, { type: 'image', body: '', mediaPath: 'sim/x.png' });
    await runTurn(ctx);
    expect(s.state.handoffReason).toBe('media_received');
  });

  it('sem conduta configurada: áudio sem transcrição passa para humano no intake', async () => {
    const s = createSession('a', '5511999990000');
    const ctx = buildSimulatorContext(s, agent(null), llm(), noVision);
    const m = appendUser(s, { type: 'audio', body: '', transcript: null });
    expect(await intake(ctx, m, true)).toBe('handed_off');
  });
});
