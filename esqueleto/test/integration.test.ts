import { describe, expect, it } from 'vitest';
import type { Agent, FollowUpStep, WhatsAppTemplate } from '../src/engine/types';
import { renderTemplate, templateParams, templateVarCount, windowOpen, WINDOW_MS } from '../src/engine/templates';
import { runFollowup, type FollowupDue } from '../src/engine/followup';
import { buildSimulatorContext, createSession } from '../src/adapters/simulator';
import { canonicalPhone, phoneVariants } from '../src/integrations/phone';
import { normalizeWebhook } from '../src/integrations/falefacil';
import { leadValue, normalizeWebhookUrl, toBitrixValue } from '../src/integrations/bitrix';
import { kitStageFor, leadKnownFields } from '../src/integrations/live';
import { defaultIntegration } from '../src/integrations/types';

const tpl: WhatsAppTemplate = {
  id: 't1', name: 'atendimento_4', lang: 'pt_BR',
  body: 'Olá, {{1}}! Vi que sua previsão é {{2}}. Podemos seguir?',
  params: ['{nome}', '{campo:data_parto}'],
};

describe('telefone', () => {
  it('canoniza com 55 e 9º dígito', () => {
    expect(canonicalPhone('+55 (11) 95944-4456')).toBe('5511959444456');
    expect(canonicalPhone('551195944445')).toBe('5511995944445'); // wa_id sem o 9
    expect(canonicalPhone('11959444456')).toBe('5511959444456');
    expect(canonicalPhone('551133334444')).toBe('551133334444'); // fixo: não mexe
  });
  it('variações para busca no CRM incluem com e sem 9', () => {
    const v = phoneVariants('5511959444456');
    expect(v).toContain('+5511959444456');
    expect(v).toContain('551159444456');
    expect(v).toContain('11959444456');
  });
});

describe('webhook do Fale Fácil', () => {
  it('Meta: texto', () => {
    const m = normalizeWebhook({ connection_id: 15, message: { from: '5511999990000', id: 'wamid.X', type: 'text', text: { body: 'Oi' } }, contact: { profile: { name: 'Maria' } } });
    expect(m).toMatchObject({ id: 'wamid.X', from: '5511999990000', type: 'text', text: 'Oi', name: 'Maria', fromMe: false });
  });
  it('Meta: imagem com legenda e link', () => {
    const m = normalizeWebhook({ message: { from: '55', id: 'w', type: 'image', image: { id: 'm1', mime_type: 'image/jpeg', caption: 'minha ctps', url: 'https://x/y.jpg' } } });
    expect(m).toMatchObject({ type: 'image', text: 'minha ctps', media: { id: 'm1', url: 'https://x/y.jpg', mime: 'image/jpeg' } });
  });
  it('WAPI: própria mensagem marcada', () => {
    const m = normalizeWebhook({ event: { Info: { Chat: '5545@s.whatsapp.net', IsFromMe: true, ID: 'A', PushName: 'J' }, Message: { conversation: 'oi' } } });
    expect(m).toMatchObject({ from: '5545', fromMe: true, type: 'text', text: 'oi' });
  });
  it('status/entrega não é mensagem', () => {
    expect(normalizeWebhook({ statuses: [{ id: 'x' }] })).toBeNull();
  });

  it('usa o file_url da raiz do payload quando a mídia não traz link (Meta e WAPI)', () => {
    const meta = normalizeWebhook({ message: { from: '55', id: 'w', type: 'image', image: { id: 'm1', mime_type: 'image/jpeg' } }, file_url: 'https://ff/f.jpg' });
    expect(meta?.media?.url).toBe('https://ff/f.jpg');
    const wapi = normalizeWebhook({ event: { Info: { Chat: '5545@s.whatsapp.net', ID: 'A' }, Message: { imageMessage: { mimetype: 'image/jpeg' } } }, file_url: 'https://ff/g.jpg' });
    expect(wapi?.media?.url).toBe('https://ff/g.jpg');
  });
});

describe('templates', () => {
  it('preenche variáveis com dados da lead; {nome} nunca usa o nome', () => {
    const known = { nome: 'MARIA souza', data_parto: '12/03/2027' };
    expect(templateParams(tpl, known)).toEqual(['tudo bem', '12/03/2027']);
    expect(renderTemplate(tpl, known)).toBe('Olá, tudo bem! Vi que sua previsão é 12/03/2027. Podemos seguir?');
    expect(templateVarCount(tpl.body)).toBe(2);
  });
  it('variável vazia não vai vazia (a Meta recusa)', () => {
    expect(templateParams(tpl, {})).toEqual(['tudo bem', '-']);
  });
  it('janela de 24h', () => {
    const now = Date.now();
    expect(windowOpen(null, now)).toBe(false);
    expect(windowOpen(now - 60_000, now)).toBe(true);
    expect(windowOpen(now - WINDOW_MS, now)).toBe(false);
  });
});

describe('follow-up fora da janela de 24h', () => {
  const step = (template_id?: string): FollowUpStep => ({ step: 1, delay_minutes: 10, message: 'Oi {nome}', is_active: true, template_id });
  const agent = (s: FollowUpStep): Agent => ({
    id: 'a', kit: { id: 'k', name: 'k', faq: [], media_library: [] }, provider: 'together', apiKey: 'x', model: 'm', system_prompt: '',
    required_fields: [], required_documents: [], classification_labels: [], handoff_keywords: [], max_turns: 20, debounce_seconds: 0,
    log_executions: true, followup_steps: [s], templates: [tpl],
  });
  const due = (s: FollowUpStep): FollowupDue => ({ kind: 'step', plan: { stage: 'geral', label: 'Padrão', steps: [s] }, index: 0, dueAt: 0 });

  async function run(s: FollowUpStep, free: boolean) {
    const sess = createSession('a', '5511999990000', { nome: 'Ana' });
    const ctx = buildSimulatorContext(sess, agent(s), null as any, null as any);
    const sent: string[] = [];
    ctx.channel = { ...ctx.channel, canSendFreeText: async () => free, sendTemplate: async (t) => { sent.push(`tpl:${t.name}`); } };
    const orig = ctx.channel.sendText;
    ctx.channel.sendText = async (t) => { sent.push(`txt:${t}`); await orig(t); };
    await runFollowup(ctx, due(s));
    return { sent, state: sess.state };
  }

  it('janela aberta: texto', async () => {
    expect((await run(step('t1'), true)).sent).toEqual(['txt:Oi']);
  });
  it('janela fechada: template do passo', async () => {
    expect((await run(step('t1'), false)).sent).toEqual(['tpl:atendimento_4']);
  });
  it('janela fechada sem template: pula, mas conta o passo', async () => {
    const r = await run(step(), false);
    expect(r.sent).toEqual([]);
    expect(r.state.followupStepSent).toBe(1);
  });
});

describe('Bitrix', () => {
  it('normaliza o endereço do webhook', () => {
    expect(normalizeWebhookUrl('https://prevx.bitrix24.com.br/rest/61/abc123/profile.json')).toBe('https://prevx.bitrix24.com.br/rest/61/abc123/');
    expect(() => normalizeWebhookUrl('https://prevx.bitrix24.com.br/crm/')).toThrow();
  });
  it('lê campos do lead (formulário, lista, data)', () => {
    const lead = {
      NAME: 'Maria', LAST_NAME: 'Souza', STATUS_ID: 'UC_52N96D',
      UF_A: 'estou_desempregada!', UF_B: '10993', UF_C: '2027-03-02T03:00:00+03:00',
    };
    const fields = [
      { code: 'UF_B', label: 'Categoria', type: 'enumeration', items: [{ id: '10993', value: 'DPP' }] },
      { code: 'UF_C', label: 'DN', type: 'date' },
    ];
    expect(leadValue(lead, 'UF_A')).toBe('estou desempregada!');
    expect(leadValue(lead, 'UF_B', fields[0])).toBe('DPP');
    expect(leadValue(lead, 'UF_C', fields[1])).toBe('02/03/2027');
    const cfg = { ...defaultIntegration(), field_map: [{ crm_field: 'UF_A', key: 'situacao_trabalho' }, { crm_field: 'UF_C', key: 'data_parto' }], stage_map: { em_atendimento: 'UC_52N96D' } };
    expect(leadKnownFields(lead, cfg, fields)).toEqual({ nome: 'Maria Souza', situacao_trabalho: 'estou desempregada!', data_parto: '02/03/2027' });
    expect(kitStageFor(cfg, 'UC_52N96D')).toBe('em_atendimento');
  });
  it('grava no formato do campo', () => {
    expect(toBitrixValue('ainda não nasceu, previsão 2/3/2027', { code: 'x', label: '', type: 'date' })).toBe('2027-03-02');
    expect(toBitrixValue('há 4 meses', { code: 'x', label: '', type: 'date' })).toBeNull();
    expect(toBitrixValue('dpp', { code: 'x', label: '', type: 'enumeration', items: [{ id: '1', value: 'DPP' }] })).toBe('1');
  });
});
