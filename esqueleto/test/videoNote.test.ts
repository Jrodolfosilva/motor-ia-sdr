import { describe, expect, it } from 'vitest';
import type { Agent } from '../src/engine/types';
import { sendReception } from '../src/engine/reception';
import { buildSimulatorContext, createSession } from '../src/adapters/simulator';

const agent = { id: 'a', kit: { id: 'k', name: 'k', faq: [], media_library: [] }, required_fields: [], required_documents: [] } as unknown as Agent;

describe('vídeo-recado (bolinha)', () => {
  it('vídeo sai como recado por padrão (sem legenda); video_note=false sai normal com legenda', async () => {
    const s = createSession('a');
    const ctx = buildSimulatorContext(s, agent, {} as any, { supports: () => false, analyze: async () => null });
    await sendReception(ctx, { after: 'wait', messages: [
      { kind: 'video', media: { path: 'media/oi.mp4' }, caption: 'legenda' },
      { kind: 'video', media: { path: 'media/normal.mp4' }, caption: 'legenda', video_note: false },
    ] }, null);
    const v = s.messages.filter((m) => m.type === 'video');
    expect(v.map((m) => [m.videoNote, m.body])).toEqual([[true, ''], [false, 'legenda']]);
  });
});
