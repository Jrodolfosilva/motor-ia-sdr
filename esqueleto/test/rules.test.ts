import { describe, expect, it } from 'vitest';
import { normalizeDuration, toMonths } from '../src/engine/rules/duration';
import { monthsSinceDate, parseDate, rulesMatch } from '../src/engine/rules/classificationRules';
import { RequiredFieldsStatus } from '../src/engine/rules/requiredFields';
import { inState, isNoiseReply, splitIntoBubbles, stateFor } from '../src/engine/rules/misc';
import { buildHistory } from '../src/engine/runTurn';

const today = new Date(2026, 10, 2); // 02/11/2026

describe('duration', () => {
  it('normaliza por extenso', () => {
    expect(normalizeDuration('trabalhei oito meses')).toBe('trabalhei 8 meses');
    expect(normalizeDuration('há uns vinte e tres anos')).toBe('há uns 23 anos');
    expect(normalizeDuration('um mês')).toBe('1 mês');
  });
  it('converte para meses', () => {
    expect(toMonths('2 anos')).toBe(24);
    expect(toMonths('9 semanas')).toBe(2);
    expect(toMonths('sem duração')).toBeNull();
  });
});

describe('datas e regras', () => {
  it('parseia formatos', () => {
    expect(parseDate('20/10/2025')?.getMonth()).toBe(9);
    expect(parseDate('2025-10-20')?.getDate()).toBe(20);
    expect(parseDate('outubro de 2025')?.getFullYear()).toBe(2025);
    expect(parseDate('31/02/2025')).toBeNull();
  });
  it('meses desde', () => {
    expect(monthsSinceDate('02/01/2026', today)).toBe(10);
    expect(monthsSinceDate('01/12/2026', today)).toBeNull(); // futuro
  });
  it('elegível urgente: 9 a 12 meses', () => {
    const rules = [
      { field: 'data_saida_ctps', operator: 'months_since_gte' as const, value: 9 },
      { field: 'data_saida_ctps', operator: 'months_since_lt' as const, value: 12 },
    ];
    expect(rulesMatch(rules, { data_saida_ctps: '01/01/2026' }, today)).toBe(true);
    expect(rulesMatch(rules, { data_saida_ctps: '01/08/2026' }, today)).toBe(false);
    expect(rulesMatch([], { x: 1 })).toBe(false);
  });
  it('contains sem acento', () => {
    expect(rulesMatch([{ field: 's', operator: 'contains_any', value: ['autonom'] }], { s: 'Autônoma' })).toBe(true);
  });
});

describe('roteiro', () => {
  const fields = [{ key: 'a', label: 'A', question: '?' }, { key: 'b', label: 'B', question: '?' }];
  it('frio vs quente', () => {
    expect(new RequiredFieldsStatus(fields, {}).hasAnyKnownData()).toBe(false);
    expect(new RequiredFieldsStatus(fields, { 'Você está grávida': 'sim' }).hasAnyKnownData()).toBe(true);
    expect(new RequiredFieldsStatus(fields, { a: '1', b: '' }).isComplete()).toBe(false);
  });
});

describe('misc', () => {
  it('DDD', () => {
    expect(inState(stateFor('+55 (71) 99999-0000')!)).toBe('na Bahia');
    expect(stateFor('1234')).toBeNull();
  });
  it('balões', () => {
    expect(splitIntoBubbles('a\n\nb\n\nc\n\nd')).toEqual(['a', 'b', 'c\n\nd']);
  });
  it('histórico ignora sticker e marca mídia que falhou', () => {
    const h = buildHistory([
      { id: '1', direction: 'inbound', type: 'text', body: 'oi' },
      { id: '2', direction: 'inbound', type: 'sticker', body: '' },
      { id: '3', direction: 'inbound', type: 'image', body: '[Image]', aiAnalysis: { failed: true } },
      { id: '4', direction: 'outbound', type: 'text', body: 'olá' },
    ]);
    expect(h).toEqual([
      { role: 'user', content: 'oi' },
      { role: 'user', content: '[Arquivo enviado pela lead que não deu para abrir/ler]' },
      { role: 'assistant', content: 'olá' },
    ]);
  });
});

describe('isNoiseReply', () => {
  it('resposta solta ou lixo de teclado', () => {
    for (const t of ['nao', 'Não', 'não.', 'ok', 'kkkkk', 'bla bla bla', 'asdasdasdasdsa', 'dasdasd', 'xzcv', '???', '']) {
      expect(isNoiseReply(t), t).toBe(true);
    }
  });
  it('resposta com conteúdo', () => {
    for (const t of ['depois', 'não tenho', 'mando à noite', 'prefiro não falar', 'saí em agosto', 'tô no trabalho', 'perdi a carteira']) {
      expect(isNoiseReply(t), t).toBe(false);
    }
  });
});

describe('pendência com insistência', () => {
  const fields = [
    { key: 'data_saida', label: 'Data de saída', question: 'Quando saiu?' },
    { key: 'parto', label: 'Parto', question: 'Quando nasce?', insist: 0 },
  ];
  const st = (pending: Record<string, { status: 'nao_sabe' | 'recusou'; count: number }>) =>
    new RequiredFieldsStatus(fields, {}, [], { pending });

  it('"não lembro" trava o roteiro até a IA insistir 2x (padrão)', () => {
    expect(st({ data_saida: { status: 'nao_sabe', count: 1 } }).missingQuestions().map((f) => f.key)).toContain('data_saida');
    expect(st({ data_saida: { status: 'nao_sabe', count: 2 } }).isPendingResolved('data_saida')).toBe(false);
    expect(st({ data_saida: { status: 'nao_sabe', count: 3 } }).isPendingResolved('data_saida')).toBe(true);
  });

  it('recusa: reforça 1x antes de liberar', () => {
    expect(st({ data_saida: { status: 'recusou', count: 1 } }).isPendingResolved('data_saida')).toBe(false);
    expect(st({ data_saida: { status: 'recusou', count: 2 } }).isPendingResolved('data_saida')).toBe(true);
  });

  it('insist do item troca o padrão', () => {
    expect(st({ parto: { status: 'nao_sabe', count: 1 } }).isPendingResolved('parto')).toBe(true);
  });
});
