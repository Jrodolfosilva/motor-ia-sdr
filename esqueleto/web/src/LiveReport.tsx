// Relatório das conversas reais do dia (log guardado 7 dias): leads que entraram no Bitrix × em quantos a IA atuou,
// com o histórico de cada conversa.
import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api, type AiHealth, type LiveLog, type LiveLogSummary, type LiveReport as Report } from './api';

const fmt = (d: string | null | undefined) => (d ? new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '');

function ConvBadge({ c }: { c: LiveLogSummary }) {
  const label = c.aiReplies > 0 ? `IA atuou (${c.aiReplies})` : c.inbound > 0 ? 'Respondeu, IA não atuou' : 'Sem resposta';
  return <span className={`log-badge ${c.aiReplies > 0 ? 'ok' : c.inbound > 0 ? 'warn' : ''}`}>{label}</span>;
}

function History({ agentKey, id }: { agentKey: string; id: string }) {
  const [log, setLog] = useState<LiveLog | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api.liveLog(agentKey, id).then(setLog).catch((e) => setErr(e.message)); }, [agentKey, id]);
  if (err) return <p className="error">{err}</p>;
  if (!log) return <p className="muted">Carregando…</p>;
  return (
    <div className="log-history">
      {log.messages.map((m, i) => (
        <div key={i} className={`log-msg ${m.role}`}>
          <small>{m.role === 'user' ? 'Lead' : m.role === 'assistant' ? 'IA' : 'Evento'} · {fmt(m.createdAt)}</small>
          <span>
            {m.role === 'event'
              ? (m.event?.message ?? (m.event?.kind ? `${m.event.kind}${m.event.summary ? `: ${m.event.summary}` : ''}` : m.body))
              : (m.transcript ? `🎤 ${m.transcript}` : m.body) || `[${m.type}]`}
          </span>
        </div>
      ))}
    </div>
  );
}

function ConvRow({ agentKey, c }: { agentKey: string; c: LiveLogSummary }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="log-conv">
      <button type="button" className="btn small" onClick={() => setOpen(!open)}>{open ? 'Fechar' : 'Ver conversa'}</button>
      <ConvBadge c={c} />
      <small className="muted">
        {c.inbound} msg(s) do lead · {c.status}{c.classification ? ` · ${c.classification}` : ''} · início {fmt(c.startedAt)} · última {fmt(c.lastAt)}
      </small>
      {open && <History agentKey={agentKey} id={c.id} />}
    </div>
  );
}

export function LiveReport({ agentKey }: { agentKey: string }) {
  const [days, setDays] = useState(1);
  const [rep, setRep] = useState<Report | null>(null);
  const [onlyAi, setOnlyAi] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = (d = days) => {
    setBusy(true); setErr(null);
    api.liveReport(agentKey, d).then(setRep).catch((e) => setErr(e.message)).finally(() => setBusy(false));
  };
  useEffect(() => { load(); }, [agentKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const leads = (rep?.leads ?? []).filter((l) => !onlyAi || l.conversations.some((c) => c.aiReplies > 0));

  return (
    <>
      <h3>6. Relatório do dia</h3>
      <p className="muted">Só leads criados no Bitrix no período (desde a meia-noite) × conversas que o motor registrou. Leads de outros dias ficam de fora. O log some 7 dias depois da última mensagem.</p>
      <div className="int-actions">
        <select value={days} onChange={(e) => { const d = Number(e.target.value); setDays(d); load(d); }}>
          {[1, 2, 3, 7].map((d) => <option key={d} value={d}>{d === 1 ? 'Hoje' : d === 2 ? 'Hoje e ontem' : `Últimos ${d} dias`}</option>)}
        </select>
        <button type="button" className="btn small" disabled={busy} onClick={() => load()}><RefreshCw size={13} /> Atualizar</button>
        <label className="f-check"><input type="checkbox" checked={onlyAi} onChange={(e) => setOnlyAi(e.target.checked)} /> Só onde a IA atuou</label>
      </div>
      {err && <p className="error">{err}</p>}
      {rep?.bitrixError && <p className="error">Bitrix: {rep.bitrixError} (mostrando só o log)</p>}
      {rep && (
        <div className="log-totals">
          <div><strong>{rep.totals.leads}</strong><small>leads no Bitrix</small></div>
          <div><strong>{rep.totals.replied}</strong><small>responderam</small></div>
          <div><strong>{rep.totals.aiActed}</strong><small>IA atuou</small></div>
          <div><strong>{rep.totals.conversations}</strong><small>conversas no log</small></div>
        </div>
      )}
      {!!leads.length && (
        <div className="crm-table">
          {leads.map((l) => (
            <div key={l.leadId} className="log-row">
              <span className="crm-event">
                <strong>
                  {l.name || '(sem nome)'} {l.leadUrl ? <a href={l.leadUrl} target="_blank" rel="noreferrer">lead #{l.leadId}</a> : `#${l.leadId}`}
                </strong>
                <small>{l.phone ?? 'sem telefone'} · entrou {fmt(l.createdAt)} · etapa no Bitrix: {l.bitrixStage}</small>
              </span>
              {l.conversations.length
                ? l.conversations.map((c) => <ConvRow key={c.id} agentKey={agentKey} c={c} />)
                : <small className="muted">Sem conversa com a IA (não respondeu o template ou não passou pelo motor).</small>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** Ping da IA: chave, crédito e cada modelo do agente (+ banco e Redis). */
export function AiHealthCard({ agentKey }: { agentKey: string }) {
  const [h, setH] = useState<AiHealth | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const check = () => {
    setBusy(true); setErr(null);
    api.health(agentKey).then(setH).catch((e) => setErr(e.message)).finally(() => setBusy(false));
  };
  useEffect(check, [agentKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`fu-box ai-health ${h ? (h.ok ? 'ok' : 'bad') : ''}`}>
      <div className="int-actions" style={{ marginTop: 0 }}>
        <strong>{busy ? 'Testando a IA…' : !h ? 'Status da IA' : h.ok ? '🟢 IA funcionando' : '🔴 IA com problema'}</strong>
        <button type="button" className="btn small" disabled={busy} onClick={check}><RefreshCw size={13} /> Testar agora</button>
        {h && <small className="muted">testado {fmt(h.checkedAt)}</small>}
      </div>
      {err && <p className="error">{err}</p>}
      {h && (
        <ul className="ai-health-list">
          {h.models.map((m) => (
            <li key={m.model}>
              {m.ok ? '🟢' : '🔴'} <code>{m.model}</code> <small className="muted">({m.roles.join(', ')}) · {m.ms} ms</small>
              {!m.ok && <div className="error">{m.detail}</div>}
            </li>
          ))}
          <li>{h.mongo ? '🟢' : '🔴'} Banco (MongoDB) · {h.redis ? '🟢' : '🔴'} Redis</li>
        </ul>
      )}
    </div>
  );
}
