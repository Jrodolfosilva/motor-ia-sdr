import { describe, expect, it } from 'vitest';
import type { Agent, FaqEntry, LlmProvider, LlmResult } from '../src/engine/types';
import { runTurn } from '../src/engine/runTurn';
import { nextFaqReplies } from '../src/engine/faq';
import { appendUser, buildSimulatorContext, createSession } from '../src/adapters/simulator';

const noVision = { supports: () => false, analyze: async () => null };

const faq: FaqEntry[] = [{
  question: 'Quanto vou receber?', answer: 'Entre R$ 6.400 e R$ 21.900.',
  replies: [
    { kind: 'audio', media: { path: 'media/valor.ogg', mime: 'audio/ogg' }, transcript: 'O valor fica entre...' },
    { kind: 'text', text: 'O valor costuma ficar entre R$ 6.400 e R$ 21.900 💛' },
    { kind: 'video', media: { path: 'media/valor.mp4', mime: 'video/mp4' }, enabled: false },
  ],
}, {
  question: 'Preciso ir ao INSS?', answer: 'Não, a gente faz tudo online.',
}];

function agent(): Agent {
  return {
    id: 'a', kit: { id: 'k', name: 'k', faq, media_library: [] },
    provider: 'together', apiKey: 'x', model: 'm', system_prompt: 'persona',
    required_fields: [{ key: 'saida', label: 'Saída', question: 'Quando saiu?' }], required_documents: [],
    classification_labels: [], handoff_keywords: [], max_turns: 20, debounce_seconds: 0,
    followup_steps: [], log_executions: true,
  };
}

/** Extractor não salva nada; responder escreve `text` e chama responder_faq(0) se o prompt oferecer. */
function llm(text: string, seen: string[]): LlmProvider {
  return {
    async chat({ system, tools }): Promise<LlmResult> {
      if (system?.startsWith('Você é um extrator')) return { text: '', raw: {}, toolCalls: [] };
      if (system?.includes('BASE DE CONHECIMENTO')) seen.push(system);
      const canFaq = (tools ?? []).some((t) => t.name === 'responder_faq');
      return { text, raw: {}, toolCalls: canFaq ? [{ name: 'responder_faq', arguments: { pergunta: 0 } }] : [] };
    },
  };
}

const out = (s: ReturnType<typeof createSession>) => s.messages.filter((m) => m.role === 'assistant').map((m) => `${m.type}:${m.body || m.mediaPath}`);

describe('FAQ com respostas prontas', () => {
  it('só oferece formatos ativos e com conteúdo; varia o formato', () => {
    expect(nextFaqReplies(faq, {})[0].msg.kind).toBe('audio');
    expect(nextFaqReplies(faq, { faqLastKind: 'audio' })[0].msg.kind).toBe('text');
    expect(nextFaqReplies(faq, { faqSent: ['0:0', '0:1'] })[0]).toBeUndefined();
    expect(nextFaqReplies(faq, {})[1]).toBeUndefined(); // sem resposta pronta: IA responde com o A
  });

  it('IA chama responder_faq: sai a transição dela e o áudio; na próxima vez, o texto pronto', async () => {
    const s = createSession('a', '5511999990000');
    const prompts: string[] = [];
    s.state.openingCompleted = true;
    appendUser(s, { type: 'text', body: 'quanto vou receber?' });
    await runTurn(buildSimulatorContext(s, agent(), llm('Vou te mandar um áudio explicando 😊', prompts), noVision));
    expect(out(s)).toEqual(['text:Vou te mandar um áudio explicando 😊', 'audio:media/valor.ogg']);
    expect(prompts[0]).toContain('responder_faq(0)');
    expect(prompts[0]).toContain('ÁUDIO');

    appendUser(s, { type: 'text', body: 'e quanto é mesmo?' });
    await runTurn(buildSimulatorContext(s, agent(), llm('', prompts), noVision));
    expect(out(s).slice(2)).toEqual(['text:O valor costuma ficar entre R$ 6.400 e R$ 21.900 💛']);
    expect(s.state.faqSent).toEqual(['0:0', '0:1']);

    // formatos esgotados: a IA responde com as palavras dela (sem responder_faq)
    appendUser(s, { type: 'text', body: 'repete?' });
    await runTurn(buildSimulatorContext(s, agent(), llm('Fica entre R$ 6.400 e R$ 21.900.', prompts), noVision));
    expect(out(s).at(-1)).toBe('text:Fica entre R$ 6.400 e R$ 21.900.');
  });
});
