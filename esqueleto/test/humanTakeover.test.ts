import { describe, expect, it } from 'vitest';
import { humanAuthor } from '../src/integrations/bitrix';

const lead = { id: 7661, name: 'Lead', external_auth_id: 'imconnector', connector: true, bot: false };
const op = { id: 900, name: 'Jéssica Oliveira', external_auth_id: 'default', connector: false, bot: false };
const since = new Date('2026-11-25T15:29:05+03:00');
const sys = (id: number, text: string, date = '2026-11-26T16:03:17+03:00') => ({ id, author_id: 0, date, text });

describe('humanAuthor (SDR já falou com o lead no Canal Aberto)', () => {
  it('template enviado pelo Fale Fácil Helper (lead 31585)', () => {
    const msgs = [
      sys(1, 'Conversa #9869 iniciada'),
      sys(2, 'Consulta redirecionada para [USER=7223 REPLACE]Bruno Santos[/USER] (pessoa responsável pelo CRM)'),
      { id: 3, author_id: 7661, date: '2026-11-26T16:03:17+03:00', text: '[5511970639340]' },
      sys(4, 'Fale Fácil Helper:\n*Bruno Santos:*\n📨 *Template: utilidade_3*\nTemos uma atualização', '2026-11-26T16:03:18+03:00'),
    ];
    expect(humanAuthor(msgs, [lead], since)).toBe('Bruno Santos');
  });

  it('operador digitando no Bitrix (lead 31647)', () => {
    const msgs = [
      { id: 1, author_id: 7661, date: '2026-11-26T16:08:00+03:00', text: '07/06/2027' },
      { id: 2, author_id: 900, date: '2026-11-26T16:08:30+03:00', text: 'Parabéns pela gravidez' },
    ];
    expect(humanAuthor(msgs, [lead, op], since)).toBe('Jéssica Oliveira');
  });

  it('só lead e sistema: IA segue', () => {
    const msgs = [sys(1, 'Conversa #1 iniciada'), { id: 2, author_id: 7661, date: '2026-11-26T16:07:00+03:00', text: '[Áudio]' }];
    expect(humanAuthor(msgs, [lead], since)).toBeNull();
  });

  it('mensagem de humano antes do lead existir não conta', () => {
    const msgs = [{ id: 1, author_id: 900, date: '2026-10-01T10:00:00+03:00', text: 'oi (lead antigo)' }];
    expect(humanAuthor(msgs, [op], since)).toBeNull();
  });
});
