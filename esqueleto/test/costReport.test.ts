import { describe, expect, it } from 'vitest';
import { liveStatsDoc } from '../src/adapters/liveLog';
import type { Session } from '../src/adapters/simulator';
import { dateBR, periodBR } from '../src/integrations/runtime';

describe('período do relatório de custos', () => {
  const now = new Date('2026-11-27T15:00:00Z'); // 12h em Brasília

  it('datas de Brasília, fim inclusivo', () => {
    const { from, to } = periodBR('2026-11-01', '2026-11-27', now);
    expect(from.toISOString()).toBe('2026-11-01T03:00:00.000Z');
    expect(to.toISOString()).toBe('2026-11-28T03:00:00.000Z');
  });

  it('sem datas: últimos 30 dias até hoje', () => {
    const { from, to } = periodBR('', '', now);
    expect(to.toISOString()).toBe('2026-11-28T03:00:00.000Z');
    expect(from.toISOString()).toBe('2026-10-29T03:00:00.000Z');
  });

  it('início depois do fim vira um dia só', () => {
    const { from, to } = periodBR('2026-11-30', '2026-11-27', now);
    expect(from.toISOString()).toBe('2026-11-27T03:00:00.000Z');
    expect(to.toISOString()).toBe('2026-11-28T03:00:00.000Z');
  });

  it('dateBR usa o fuso de Brasília', () => {
    expect(dateBR(new Date('2026-11-28T02:59:00Z'))).toBe('2026-11-27');
    expect(dateBR(new Date('2026-11-28T03:00:00Z'))).toBe('2026-11-28');
  });
});

describe('resumo da conversa (live_stats)', () => {
  it('soma tokens por etapa+modelo, áudio e mensagens', () => {
    const msg = (role: string, i: number) => ({ id: String(i), role, type: 'text', body: 'x', createdAt: `2026-11-27T12:0${i}:00Z` });
    const s = {
      id: 'live_k_1', agentId: 'k', phone: '5581', customFields: { nome: 'Ana' },
      state: { status: 'handed_off', classification: 'elegivel', handoffReason: 'classified' },
      messages: [msg('assistant', 0), msg('user', 1), msg('assistant', 2), msg('assistant', 3), msg('user', 4)],
      logs: [
        { step: 'responder', model: 'm1', raw: { usage: { prompt_tokens: 100, completion_tokens: 10 } } },
        { step: 'responder', model: 'm1', raw: { usage: { prompt_tokens: 50, completion_tokens: 5 } } },
        { step: 'extractor', model: 'm2', raw: { usage: { prompt_tokens: 30, completion_tokens: 3 } } },
      ],
      audioUsage: [{ model: 'w', seconds: 12, messageId: '1' }, { model: 'w', seconds: 8, messageId: '4' }],
      live: { kitKey: 'k', leadId: '9', portal: 'https://x.bitrix24.com.br', startedAt: '2026-11-27T12:00:00Z' },
    } as unknown as Session;
    const d = liveStatsDoc(s);
    expect(d.kitKey).toBe('k');
    expect(d.inbound).toBe(2);
    expect(d.aiReplies).toBe(2);
    expect(d.outbound).toBe(3);
    expect(d.handoffReason).toBe('classified');
    const r = d.usage.find((u) => u.step === 'responder')!;
    expect(r).toMatchObject({ model: 'm1', calls: 2, input: 150, output: 15 });
    expect(d.usage).toHaveLength(2);
    expect(d.audio).toEqual([{ model: 'w', seconds: 20, usd: null }]);
  });
});
