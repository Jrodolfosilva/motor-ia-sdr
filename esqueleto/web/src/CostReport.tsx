// Relatório geral das conversas reais por período: custo da IA, mensagens e desfecho (qualificada/desqualificada).
// Lê o resumo permanente (live_stats) — não depende do log de 7 dias.
import { useEffect, useMemo, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { api, type CostOutcome, type CostReport as Report } from './api';
import { brl, usd } from './CostPanel';

const nf = (n: number) => n.toLocaleString('pt-BR');
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '—');
const fmt = (d: string) => new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const dmy = (iso: string) => iso.split('-').reverse().join('/');

const OUTCOME: Record<CostOutcome, { label: string; cls: string }> = {
  qualified: { label: 'Qualificada', cls: 'ok' },
  disqualified: { label: 'Desqualificada', cls: 'bad' },
  team: { label: 'Passou p/ equipe', cls: 'warn' },
  open: { label: 'Em andamento', cls: '' },
  no_reply: { label: 'Sem resposta', cls: '' },
};

const REASON: Record<string, string> = {
  media_received: 'mídia', file_received: 'arquivo', handoff_keyword: 'pediu humano', max_turns_exceeded: 'limite de turnos',
  turn_failed: 'erro da IA', followup_exhausted: 'follow-up esgotado',
};

// datas em Brasília (AAAA-MM-DD)
const todayBR = () => new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10);
const shift = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
function preset(p: string): [string, string] {
  const t = todayBR();
  const [y, m] = t.split('-').map(Number);
  const first = (yy: number, mm: number) => `${yy}-${String(mm).padStart(2, '0')}-01`;
  switch (p) {
    case 'today': return [t, t];
    case '7': return [shift(t, -6), t];
    case 'month': return [first(y, m), t];
    case 'last_month': {
      const [py, pm] = m === 1 ? [y - 1, 12] : [y, m - 1];
      return [first(py, pm), shift(first(y, m), -1)];
    }
    default: return [shift(t, -29), t];
  }
}

function toCsv(r: Report): string {
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['início', 'nome', 'telefone', 'lead', 'desfecho', 'classificação', 'msgs lead', 'respostas IA', 'enviadas total', 'custo R$', 'custo US$'];
  const rows = r.conversations.map((c) => [
    fmt(c.startedAt), c.name, c.phone, c.leadId, OUTCOME[c.outcome].label, c.classificationLabel,
    c.inbound, c.aiReplies, c.outbound, c.brl.toFixed(4).replace('.', ','), c.usd.toFixed(5).replace('.', ','),
  ]);
  return [head, ...rows].map((l) => l.map(esc).join(';')).join('\n');
}

export default function CostReport({ agentKey }: { agentKey: string }) {
  const [[from, to], setPeriod] = useState<[string, string]>(() => preset('30'));
  const [rep, setRep] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<CostOutcome | ''>('');
  const [presetKey, setPresetKey] = useState('30');

  const load = (f = from, t = to) => {
    setBusy(true); setErr(null);
    api.costReport(agentKey, f, t).then(setRep).catch((e) => setErr(e.message)).finally(() => setBusy(false));
  };
  useEffect(() => { load(); }, [agentKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = (f: string, t: string) => { setPeriod([f, t]); load(f, t); };
  const convs = useMemo(() => (rep?.conversations ?? []).filter((c) => !filter || c.outcome === filter), [rep, filter]);

  const download = () => {
    if (!rep) return;
    const blob = new Blob([`﻿${toCsv(rep)}`], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `relatorio-${agentKey}-${rep.from}_${rep.to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const t = rep?.totals;
  return (
    <>
      <section className="card">
        <div className="card-head">
          <div>
            <h2>Relatório geral</h2>
            <p>Conversas reais (WhatsApp) iniciadas no período: custo da IA, mensagens e quantas foram qualificadas ou desqualificadas.</p>
          </div>
        </div>
        <div className="int-actions rep-period">
          <select value={presetKey} onChange={(e) => { setPresetKey(e.target.value); if (e.target.value) apply(...preset(e.target.value)); }}>
            <option value="today">Hoje</option>
            <option value="7">Últimos 7 dias</option>
            <option value="30">Últimos 30 dias</option>
            <option value="month">Este mês</option>
            <option value="last_month">Mês passado</option>
            <option value="">Personalizado</option>
          </select>
          <input type="date" value={from} max={to} onChange={(e) => { setPresetKey(''); setPeriod([e.target.value, to]); }} />
          <span className="muted">até</span>
          <input type="date" value={to} min={from} onChange={(e) => { setPresetKey(''); setPeriod([from, e.target.value]); }} />
          <button type="button" className="btn small" disabled={busy} onClick={() => load()}><RefreshCw size={13} /> {busy ? 'Carregando…' : 'Gerar'}</button>
          <button type="button" className="btn small" disabled={!rep?.conversations.length} onClick={download}><Download size={13} /> CSV</button>
        </div>
        {err && <p className="error">{err}</p>}

        {rep && t && (
          <>
            <p className="muted rep-sub">{dmy(rep.from)} a {dmy(rep.to)}</p>
            <div className="log-totals rep-kpis">
              <div className="rep-main"><strong>{brl(t.brl)}</strong><small>custo da IA · {usd(t.usd)}</small></div>
              <div><strong>{nf(t.conversations)}</strong><small>conversas</small></div>
              <div><strong>{brl(t.perConversationBrl)}</strong><small>por conversa</small></div>
              <div><strong>{t.qualified ? brl(t.perQualifiedBrl) : '—'}</strong><small>por qualificada</small></div>
            </div>

            <h3>Desfecho</h3>
            <div className="log-totals rep-outcomes">
              <div className="ok"><strong>{nf(t.qualified)}</strong><small>qualificadas · {pct(t.qualified, t.conversations)}</small></div>
              <div className="bad"><strong>{nf(t.disqualified)}</strong><small>desqualificadas · {pct(t.disqualified, t.conversations)}</small></div>
              <div><strong>{nf(t.team)}</strong><small>passaram p/ equipe sem classificar</small></div>
              <div><strong>{nf(t.open)}</strong><small>em andamento</small></div>
              <div><strong>{nf(t.noReply)}</strong><small>sem resposta do lead</small></div>
            </div>

            <h3>Mensagens</h3>
            <div className="log-totals">
              <div><strong>{nf(t.outbound)}</strong><small>enviadas (total, com template e follow-up)</small></div>
              <div><strong>{nf(t.aiReplies)}</strong><small>respostas da IA</small></div>
              <div><strong>{nf(t.inbound)}</strong><small>recebidas do lead</small></div>
              <div><strong>{nf(t.aiActed)}</strong><small>conversas em que a IA atuou · {pct(t.aiActed, t.conversations)}</small></div>
            </div>

            {!!rep.byClassification.length && (
              <>
                <h3>Por classificação</h3>
                <table className="cost-table">
                  <thead><tr><th>Classificação</th><th>Tipo</th><th className="num">Conversas</th><th className="num">%</th></tr></thead>
                  <tbody>
                    {rep.byClassification.map((c) => (
                      <tr key={c.key}>
                        <td>{c.label}</td>
                        <td><span className={`log-badge ${OUTCOME[c.outcome].cls}`}>{OUTCOME[c.outcome].label}</span></td>
                        <td className="num">{nf(c.count)}</td>
                        <td className="num">{pct(c.count, t.conversations)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </>
        )}
      </section>

      {rep && t && (
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Custo por etapa</h2>
              <p>{nf(t.input)} tokens de entrada · {nf(t.output)} de saída{t.audioSeconds ? ` · ${(t.audioSeconds / 60).toFixed(1)} min de áudio` : ''}. US$ 1 = R$ {rep.fx.rate.toLocaleString('pt-BR', { minimumFractionDigits: 4 })} ({rep.fx.source}).</p>
            </div>
          </div>
          {rep.byStep.length ? (
            <table className="cost-table">
              <thead><tr><th>Etapa</th><th className="num">Chamadas</th><th className="num">Entrada</th><th className="num">Saída</th><th className="num">R$</th><th className="num">%</th></tr></thead>
              <tbody>
                {rep.byStep.map((s) => (
                  <tr key={`${s.step}|${s.model}`}>
                    <td>{s.label}<span className="cost-model">{s.model}</span></td>
                    <td className="num">{s.step === 'transcription' ? `${(s.seconds / 60).toFixed(1)} min` : nf(s.calls)}</td>
                    <td className="num">{s.step === 'transcription' ? '—' : nf(s.input)}</td>
                    <td className="num">{s.step === 'transcription' ? '—' : nf(s.output)}</td>
                    <td className="num" title={usd(s.usd)}>{brl(s.brl)}</td>
                    <td className="num">{pct(s.usd, t.usd)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr><td>Total</td><td /><td className="num">{nf(t.input)}</td><td className="num">{nf(t.output)}</td><td className="num">{brl(t.brl)}</td><td /></tr></tfoot>
            </table>
          ) : <p className="empty">Nenhuma chamada de IA no período.</p>}
          {rep.unpriced.length > 0 && <div className="cost-warn">Sem preço na tabela do Together: {rep.unpriced.join(', ')} (contado como R$ 0).</div>}
          {rep.prices.error && <div className="cost-warn">Não consegui atualizar a tabela de preços: {rep.prices.error}</div>}

          {rep.byDay.length > 1 && (
            <>
              <h3>Por dia</h3>
              <table className="cost-table">
                <thead><tr><th>Dia</th><th className="num">Conversas</th><th className="num">Qualificadas</th><th className="num">Desqualificadas</th><th className="num">Custo</th></tr></thead>
                <tbody>
                  {rep.byDay.map((d) => (
                    <tr key={d.date}>
                      <td>{dmy(d.date)}</td>
                      <td className="num">{nf(d.conversations)}</td>
                      <td className="num">{nf(d.qualified)}</td>
                      <td className="num">{nf(d.disqualified)}</td>
                      <td className="num">{brl(d.brl)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>
      )}

      {rep && (
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Conversas ({nf(convs.length)})</h2>
              <p>Custo de cada conversa até agora. O histórico das mensagens fica na aba Configuração › Integração (7 dias).</p>
            </div>
            <select value={filter} onChange={(e) => setFilter(e.target.value as CostOutcome | '')}>
              <option value="">Todos os desfechos</option>
              {(Object.keys(OUTCOME) as CostOutcome[]).map((o) => <option key={o} value={o}>{OUTCOME[o].label}</option>)}
            </select>
          </div>
          {convs.length ? (
            <div className="rep-scroll">
              <table className="cost-table">
                <thead><tr><th>Início</th><th>Lead</th><th>Desfecho</th><th className="num">Lead</th><th className="num">IA</th><th className="num">Custo</th></tr></thead>
                <tbody>
                  {convs.map((c) => (
                    <tr key={c.id}>
                      <td>{fmt(c.startedAt)}</td>
                      <td>
                        {c.name || '(sem nome)'}
                        <span className="cost-model">
                          {c.phone}{c.leadId ? ' · ' : ''}
                          {c.leadId && (c.leadUrl ? <a href={c.leadUrl} target="_blank" rel="noreferrer">lead #{c.leadId}</a> : `lead #${c.leadId}`)}
                        </span>
                      </td>
                      <td>
                        <span className={`log-badge ${OUTCOME[c.outcome].cls}`}>{OUTCOME[c.outcome].label}</span>
                        {c.outcome === 'team' && c.handoffReason && <span className="cost-model">{REASON[c.handoffReason] ?? c.handoffReason}</span>}
                        {(c.outcome === 'qualified' || c.outcome === 'disqualified') && c.classificationLabel && <span className="cost-model">{c.classificationLabel}</span>}
                      </td>
                      <td className="num">{nf(c.inbound)}</td>
                      <td className="num">{nf(c.aiReplies)}</td>
                      <td className="num" title={usd(c.usd)}>{brl(c.brl)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="empty">Nenhuma conversa no período.</p>}
        </section>
      )}
    </>
  );
}
