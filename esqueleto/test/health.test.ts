import { describe, expect, it } from 'vitest';
import { classify } from '../src/providers/health';
import { startOfDayBR } from '../src/integrations/runtime';

describe('startOfDayBR', () => {
  it('meia-noite de Brasília = 03:00 UTC', () => {
    expect(startOfDayBR(0, new Date('2026-11-26T15:00:00Z')).toISOString()).toBe('2026-11-26T03:00:00.000Z');
  });
  it('01:00 UTC ainda é o dia anterior em Brasília', () => {
    expect(startOfDayBR(0, new Date('2026-11-26T01:00:00Z')).toISOString()).toBe('2026-11-25T03:00:00.000Z');
  });
  it('daysBack volta dias inteiros', () => {
    expect(startOfDayBR(1, new Date('2026-11-26T15:00:00Z')).toISOString()).toBe('2026-11-25T03:00:00.000Z');
  });
});

describe('classify (ping da IA)', () => {
  it('chave inválida', () => expect(classify(401, '{"error":{"message":"Invalid API key provided."}}')).toBe('invalid_key'));
  it('sem crédito', () => expect(classify(402, 'Payment required')).toBe('no_credit'));
  it('crédito pela mensagem', () => expect(classify(429, 'Credit limit exceeded')).toBe('no_credit'));
  it('limite de uso', () => expect(classify(429, 'rate limit')).toBe('rate_limited'));
  it('modelo', () => expect(classify(404, 'model not found')).toBe('model_not_found'));
});
