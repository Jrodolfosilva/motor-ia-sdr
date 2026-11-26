import { describe, expect, it } from 'vitest';
import { dateKindFor, inferYear } from '../src/engine/rules/dates';
import { leadValue } from '../src/integrations/bitrix';

const now = new Date(2026, 10, 26); // 26/11/2026

describe('data sem ano', () => {
  it('saída (passado): ano atual, ou o passado se cairia no futuro', () => {
    expect(inferYear('21 de janeiro', 'past', now)).toBe('21/01/2026');
    expect(inferYear('dezembro', 'past', now)).toBe('12/2025');
    expect(inferYear('saí dia 18 de novembro agora', 'past', now)).toBe('saí dia 18/11/2026 agora');
    expect(inferYear('30/12', 'past', now)).toBe('30/12/2025');
    expect(inferYear('março do ano passado', 'past', now)).toBe('03/2025 do ano passado');
  });

  it('previsão do parto (futuro): ano que vem se o mês já passou', () => {
    expect(inferYear('15 de abril', 'future', now)).toBe('15/04/2027');
    expect(inferYear('Junho', 'future', now)).toBe('06/2027');
    expect(inferYear('ainda não nasceu, previsão 23 de janeiro', 'future', now)).toBe('ainda não nasceu, previsão 23/01/2027');
    expect(inferYear('19 de dezembro', 'future', now)).toBe('19/12/2026');
  });

  it('bebê que já nasceu conta como data passada', () => {
    expect(inferYear('nasceu dia 10 de dezembro', 'future', now)).toBe('nasceu dia 10/12/2025');
  });

  it('data completa, só ano ou sem data: fica igual', () => {
    expect(inferYear('20/10/2026', 'past', now)).toBe('20/10/2026');
    expect(inferYear('janeiro de 2026', 'past', now)).toBe('janeiro de 2026');
    expect(inferYear('Em 2024', 'past', now)).toBe('Em 2024');
    expect(inferYear('20', 'future', now)).toBe('20');
    expect(inferYear('há 4 meses', 'past', now)).toBe('há 4 meses');
  });

  it('tipo pela chave do campo', () => {
    expect(dateKindFor({ key: 'data_saida_ctps' })).toBe('past');
    expect(dateKindFor({ key: 'data_parto' })).toBe('future');
    expect(dateKindFor({ key: 'seguro_desemprego' })).toBeNull();
  });
});

describe('valor do Bitrix', () => {
  it('"0" vazio e checkbox viram vazio/sim', () => {
    expect(leadValue({ X: '0' }, 'X')).toBe('');
    expect(leadValue({ X: 0 }, 'X', { code: 'X', label: '', type: 'string' })).toBe('');
    expect(leadValue({ X: '0' }, 'X', { code: 'X', label: '', type: 'integer' })).toBe('0');
    expect(leadValue({ X: '1' }, 'X', { code: 'X', label: '', type: 'boolean' })).toBe('sim');
    expect(leadValue({ X: '0' }, 'X', { code: 'X', label: '', type: 'boolean' })).toBe('');
  });
});
