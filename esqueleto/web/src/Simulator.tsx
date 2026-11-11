import { useEffect, useRef, useState } from 'react';
import {
  Activity, AlertCircle, CheckCircle2, Circle, ClipboardList, Cpu, FileCheck2, FileClock, FileText, Plus, Repeat, RotateCcw, Users, Zap,
} from 'lucide-react';
import CostPanel, { brl, usd } from './CostPanel';
import { api, type PendingStatus, type RequiredDocument, type CrmConfig, type RequiredField, type Session, } from './api';
import Phone, { COLD_LEAD_DRAFT } from './Phone';
import type { TestLead } from './api';

const STATUS_LABEL: Record<string, { text: string; tone: string }> = {
  active: { text: 'Em atendimento', tone: 'success' },
  handing_off: { text: 'Passando p/ humano', tone: 'warning' },
  handed_off: { text: 'Com humano', tone: 'warning' },
};

type LeadKind = 'frio' | 'formulario';
type QState = 'missing' | 'to_confirm' | 'confirmed' | 'collected';

const filled = (v: unknown) => v !== undefined && v !== null && String(v).trim() !== '';

const PENDING_BADGE: Record<PendingStatus, { text: string; tone: string }> = {
  depois: { text: 'vai mandar depois', tone: 'warning' },
  nao_tem: { text: 'não tem', tone: 'danger' },
  recusou: { text: 'recusou', tone: 'danger' },
};
const RESOLVES_AT: Record<PendingStatus, number> = { recusou: 1, nao_tem: 2, depois: 2 };

const Q_LABEL: Record<QState, { text: string; tone: string }> = {
  missing: { text: 'falta', tone: 'neutral' },
  to_confirm: { text: 'do form · a confirmar', tone: 'warning' },
  confirmed: { text: 'confirmado', tone: 'success' },
  collected: { text: 'coletado', tone: 'success' },
};

/** Lê "chave: valor" por linha. */
function parseExtras(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) {
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (k && v) out[k] = v;
    }
  }
  return out;
}

export default function Simulator({ agentKey }: { agentKey: string }) {
  const [session, setSession] = useState<Session | null>(null);
  const [agentName, setAgentName] = useState('Atendimento');
  const [fields, setFields] = useState<RequiredField[]>([]);
  const [docs, setDocs] = useState<RequiredDocument[]>([]);
  const [crmCfg, setCrmCfg] = useState<CrmConfig | null>(null);
  const [testLead, setTestLead] = useState<TestLead | null>(null);
  const [phone, setPhone] = useState('5511999999999');
  const [leadKind, setLeadKind] = useState<LeadKind>('formulario');
  const [nome, setNome] = useState('Maria');
  const [form, setForm] = useState<Record<string, string>>({});
  const [extras, setExtras] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const [kicking, setKicking] = useState(false);
  useEffect(() => setKicking(false), [session?.id]);

  const customFields = (): Record<string, unknown> => {
    if (leadKind === 'frio') return {};
    const out: Record<string, unknown> = {};
    if (nome.trim()) out.nome = nome.trim();
    for (const [k, v] of Object.entries(form)) if (v.trim()) out[k] = v.trim();
    return { ...out, ...parseExtras(extras) };
  };

  const run = async (fn: () => Promise<Session>) => {
    setBusy(true);
    setError(null);
    try {
      setSession(await fn());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const loadAgent = () =>
    api.getAgent(agentKey).then((a) => {
      setAgentName(a.kit.agent.name ?? a.kit.kit.name);
      setTestLead(a.kit.agent.test_lead ?? null);
      setFields(a.kit.agent.required_fields);
      setDocs(a.kit.agent.required_documents ?? []);
      setCrmCfg(a.kit.agent.crm ?? null);
    }).catch(() => {});

  // atualizações ao vivo: balões chegam um a um, com "digitando…" entre eles
  useEffect(() => {
    if (!session?.id) return;
    return api.stream(session.id, setSession);
  }, [session?.id]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    run(() => api.create({ agent: agentKey }, phone, {}));
    loadAgent();
    // recarrega nome/roteiro quando o agente for salvo na outra aba
    const onHash = () => { if (location.hash !== '#agente') loadAgent(); };
    // (o simulador é recriado quando o agente aberto muda: key={agentKey} no App)
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const optimistic = (m: Session['messages'][number]) =>
    session && setSession({ ...session, messages: [...session.messages, m] });

  // envio não bloqueia: o lead pode escrever no meio da resposta (a resposta chega pelo stream)
  const fail = (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    // sessões ficam em memória: se o backend reiniciou, a conversa aberta deixou de existir
    setError(msg.startsWith('404') ? 'Esta conversa não existe mais (o servidor reiniciou). Clique em "Nova conversa".' : msg);
  };

  const send = (body: string) => {
    if (!session) return;
    setError(null);
    optimistic({ id: `tmp-${Date.now()}`, role: 'user', type: 'text', body, createdAt: new Date().toISOString() });
    api.send(session.id, body).catch(fail);
  };

  const sendAudio = (audio: Blob) => {
    if (!session) return;
    setError(null);
    optimistic({ id: `tmp-${Date.now()}`, role: 'user', type: 'audio', body: '', createdAt: new Date().toISOString(), mediaPath: null, transcribing: true });
    api.sendAudio(session.id, audio).catch(fail);
  };

  const sendFile = (file: File, caption: string) => {
    if (!session) return;
    setError(null);
    optimistic({
      id: `tmp-${Date.now()}`, role: 'user', type: file.type === 'application/pdf' ? 'document' : file.type.startsWith('video/') ? 'video' : 'image',
      body: caption, createdAt: new Date().toISOString(), fileName: file.name,
    });
    api.sendFile(session.id, file, caption).catch(fail);
  };

  const cf = session?.customFields ?? {};
  const st = session?.state;
  // antes do 1º turno o motor ainda não fixou formKeys: prevê pelo que veio preenchido
  const formKeys = new Set(st?.formKeys ?? fields.filter((f) => filled(cf[f.key])).map((f) => f.key));
  const confirmed = new Set(st?.confirmedKeys ?? []);
  const validatedBy = (key: string) => docs.filter((d) => d.validates?.includes(key) && filled(cf[d.key]));
  const qState = (f: RequiredField): QState => {
    if (!filled(cf[f.key])) return 'missing';
    if (!formKeys.has(f.key)) return 'collected';
    if (confirmed.has(f.key) || validatedBy(f.key).length) return 'confirmed';
    return 'to_confirm';
  };

  const qDone = fields.filter((f) => ['confirmed', 'collected'].includes(qState(f))).length;
  const dDone = docs.filter((d) => filled(cf[d.key])).length;
  const total = fields.length + docs.length;
  const done = qDone + dDone;
  const known = new Set([...fields.map((f) => f.key), ...docs.map((d) => d.key)]);
  const extra = Object.keys(cf).filter((k) => !known.has(k));
  const status = STATUS_LABEL[st?.status ?? ''] ?? { text: st?.status ?? '…', tone: 'neutral' };
  const isFormLead = formKeys.size > 0 || extra.length > 0;
  // conversa ainda vazia: lead frio já vem com a 1ª mensagem escrita; lead de formulário tem "Iniciar"
  const hasForm = Object.keys(cf).length > 0;
  const untouched = !!session && (session.messages?.length ?? 0) === 0 && (st?.turnsCount ?? 0) === 0;
  const kick = () => {
    if (!session) return;
    setKicking(true);
    api.start(session.id).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };
  const pendingOf = (key: string) => (filled(cf[key]) ? null : st?.pending?.[key] ?? null);

  return (
    <div className="sim">
      <div className="card sim-stage">
        <Phone
          key={session?.id}
          draft={untouched && !hasForm ? testLead?.cold_message || COLD_LEAD_DRAFT : ''}
          startButton={untouched && hasForm ? { label: kicking ? 'Iniciando…' : 'Iniciar', disabled: kicking, onClick: kick } : null}
          contactName={agentName}
          messages={session?.messages ?? []}
          typing={session?.typing || false}
          closed={!!session && st?.status !== 'active'}
          documents={docs}
          onSend={send}
          onSendFile={sendFile}
          onSendAudio={sendAudio}
        />
        {error && <div className="alert danger">Erro: {error}</div>}
      </div>

      <div className="sim-side">
        <div className="stats">
          <div className="stat">
            <span className="stat-icon"><Activity size={18} strokeWidth={1.8} /></span>
            <span className={`badge ${status.tone}`}>{status.text}</span>
            <small>{st?.classification ? `Classificação: ${st.classification}` : isFormLead ? 'Lead de formulário' : 'Lead frio'}</small>
          </div>
          <div className="stat">
            <span className="stat-icon"><Repeat size={18} strokeWidth={1.8} /></span>
            <strong>{String(st?.turnsCount ?? 0)}</strong>
            <small>Turnos</small>
          </div>
          <div className="stat">
            <span className="stat-icon"><ClipboardList size={18} strokeWidth={1.8} /></span>
            <strong>{done}<span className="of">/{total}</span></strong>
            <small>Roteiro ({qDone}/{fields.length} perguntas · {dDone}/{docs.length} docs)</small>
          </div>
          <div className="stat">
            <span className="stat-icon"><Cpu size={18} strokeWidth={1.8} /></span>
            <strong className="stat-money">{brl(session?.cost?.totals.brl ?? 0)}</strong>
            <small>Custo · {usd(session?.cost?.totals.usd ?? 0)} · {session?.cost?.items.length ?? 0} chamadas</small>
          </div>
        </div>

        {crmCfg && <KanbanCard cfg={crmCfg} crm={session?.crm} />}

        <section className="card">
          <div className="card-head">
            <div>
              <h2>Novo lead</h2>
              <p>Escolha como o lead chega. Vale a partir de "Nova conversa".</p>
            </div>
          </div>
          <div className="seg">
            <button className={leadKind === 'formulario' ? 'on' : ''} onClick={() => setLeadKind('formulario')}>
              <Zap size={16} /> Formulário (Meta/LP)
            </button>
            <button className={leadKind === 'frio' ? 'on' : ''} onClick={() => setLeadKind('frio')}>
              <Users size={16} /> Frio (volume)
            </button>
          </div>
          <p className="seg-hint">
            {leadKind === 'formulario'
              ? 'Mais comum. Já chega com dados principais: a IA confirma e pede os documentos que comprovam.'
              : 'Menos comum. Chega sem nada: a IA faz a pré-qualificação completa.'}
          </p>

          <div className="form-grid">
            <label className="f">
              <span>Telefone (DDD)</span>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} />
            </label>
            {leadKind === 'formulario' && (
              <label className="f">
                <span>Nome</span>
                <input value={nome} onChange={(e) => setNome(e.target.value)} />
              </label>
            )}
          </div>

          {leadKind === 'formulario' && (
            <>
              <div className="form-sub">Respostas do formulário (deixe vazio o que o form não pergunta)</div>
              <div className="form-grid">
                {fields.map((f) => (
                  <label key={f.key} className="f">
                    <span><code>{f.key}</code></span>
                    <input
                      value={form[f.key] ?? ''}
                      placeholder={f.label.length > 60 ? f.label.slice(0, 57) + '…' : f.label}
                      onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                    />
                  </label>
                ))}
              </div>
              <label className="f">
                <span>Outros campos do form (chave: valor, um por linha)</span>
                <textarea rows={2} value={extras} onChange={(e) => setExtras(e.target.value)} placeholder={Object.entries(testLead?.form_answers ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n') || 'Pergunta do formulário: resposta'} />
              </label>
            </>
          )}

          <div className="row">
            <button className="btn primary" disabled={busy} onClick={() => run(() => api.create({ agent: agentKey }, phone, customFields()))}><Plus size={16} /> Nova conversa</button>
            <button className="btn" disabled={busy || !session} onClick={() => session && run(() => api.reset(session.id, customFields()))}><RotateCcw size={16} /> Reiniciar</button>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <h2>Roteiro</h2>
              <p>Perguntas (texto) e documentos (arquivo) separados.</p>
            </div>
            <span className="badge neutral">{done} de {total}</span>
          </div>
          <div className="progress"><span style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></div>

          <div className="roteiro-title">Perguntas</div>
          <ul className="checklist">
            {fields.map((f) => {
              const s = qState(f);
              const by = validatedBy(f.key);
              const pend = pendingOf(f.key);
              return (
                <li key={f.key} className={`q-${s}${pend ? ' pend' : ''}`}>
                  {s === 'missing' ? <Circle size={17} /> : s === 'to_confirm' ? <AlertCircle size={17} /> : <CheckCircle2 size={17} />}
                  <div>
                    <span className="li-head">
                      <code>{f.key}</code>
                      {pend ? <PendBadge p={pend} /> : <span className={`badge ${Q_LABEL[s].tone}`}>{Q_LABEL[s].text}</span>}
                    </span>
                    {pend?.detail && <span className="via">"{pend.detail}"</span>}
                    {filled(cf[f.key]) && <span className="value">{String(cf[f.key])}</span>}
                    {by.length > 0 && <span className="via">comprovado por {by.map((d) => d.label).join(', ')}</span>}
                  </div>
                </li>
              );
            })}
          </ul>

          <div className="roteiro-title">Documentos</div>
          <ul className="checklist">
            {docs.map((d) => {
              const ok = filled(cf[d.key]);
              const pend = pendingOf(d.key);
              return (
                <li key={d.key} className={ok ? 'q-collected' : pend ? 'pend' : ''}>
                  {ok ? <FileCheck2 size={17} /> : <FileClock size={17} />}
                  <div>
                    <span className="li-head">
                      <code>{d.key}</code>
                      {pend ? <PendBadge p={pend} /> : <span className={`badge ${ok ? 'success' : 'neutral'}`}>{ok ? 'recebido' : 'falta'}</span>}
                    </span>
                    {pend?.detail && <span className="via">"{pend.detail}"</span>}
                    <span className="value">{ok ? String(cf[d.key]) : d.label}</span>
                    {!ok && d.validates?.length ? <span className="via">comprova: {d.validates.join(', ')}</span> : null}
                  </div>
                </li>
              );
            })}
            {docs.length === 0 && <li className="empty-li"><FileText size={17} /> Nenhum documento no roteiro.</li>}
          </ul>

          {extra.length > 0 && (
            <>
              <div className="roteiro-title">Outros dados do formulário</div>
              <ul className="checklist">
                {extra.map((k) => (
                  <li key={k} className="q-collected extra">
                    <CheckCircle2 size={17} />
                    <div><code>{k}</code><span className="value">{String(cf[k])}</span></div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        {session?.cost && <CostPanel cost={session.cost} />}

        <section className="card">
          <div className="card-head">
            <div>
              <h2>Chamadas LLM</h2>
              <p>System prompt enviado em cada passo.</p>
            </div>
          </div>
          {session?.logs.length ? (
            <div className="logs">
              {session.logs.map((l, i) => (
                <details key={i}>
                  <summary>
                    <span className={`badge step-${l.step}`}>{l.step}</span>
                    <span className="log-model">{l.model}</span>
                  </summary>
                  <pre>{l.systemPrompt}</pre>
                </details>
              ))}
            </div>
          ) : <p className="empty">Nenhuma chamada ainda. Mande uma mensagem.</p>}
        </section>

        <details className="card raw">
          <summary>Estado bruto (JSON)</summary>
          <pre>{JSON.stringify({ state: session?.state, customFields: session?.customFields }, null, 2)}</pre>
        </details>
      </div>
    </div>
  );
}

function PendBadge({ p }: { p: { status: PendingStatus; count: number } }) {
  const b = PENDING_BADGE[p.status];
  const released = p.count >= RESOLVES_AT[p.status];
  return (
    <span className={`badge ${b.tone}`} title={released ? 'Não trava mais o roteiro: vai como pendência para a equipe' : `${p.count}x`}>
      {b.text}{p.count > 1 ? ` · ${p.count}x` : ''}{released ? ' · liberado' : ''}
    </span>
  );
}

/** Onde o card da lead estaria no kanban do CRM (simulado). */
function KanbanCard({ cfg, crm }: { cfg: CrmConfig; crm?: Session['crm'] }) {
  const stage = cfg.stages.find((x) => x.id === crm?.stageId);
  const label = (id: string) => cfg.labels.find((l) => l.id === id);
  const time = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return (
    <section className="card kanban-card">
      <div className="card-head" style={{ marginBottom: 0 }}>
        <div>
          <h2>Kanban (CRM)</h2>
          <p>Onde o card desta lead estaria no funil.</p>
        </div>
      </div>
      <span className={`kanban-stage${stage ? '' : ' none'}`}>{stage ? stage.name : 'Ainda não movido'}</span>
      <div className="kanban-labels">
        {(crm?.labels ?? []).map((id) => {
          const l = label(id);
          return (
            <span key={id} className="crm-tag add" style={{ textDecoration: 'none' }}>
              <span className="crm-dot" style={{ background: l?.color ?? '#9ca3af' }} />{l?.name ?? id}
            </span>
          );
        })}
        {!crm?.labels.length && <small className="muted" style={{ margin: 0 }}>Sem etiquetas.</small>}
      </div>
      {!!crm?.history.length && (
        <details>
          <summary className="muted" style={{ margin: 0, cursor: 'pointer' }}>Histórico ({crm.history.length})</summary>
          <ul className="kanban-history">
            {crm.history.map((h, i) => (
              <li key={i}>
                {time(h.at)} ·{' '}
                {h.stageId && <>→ <b>{cfg.stages.find((x) => x.id === h.stageId)?.name ?? h.stageId}</b></>}
                {h.add?.map((id) => <span key={id}> +{label(id)?.name ?? id}</span>)}
                {h.remove?.map((id) => <span key={id}> −{label(id)?.name ?? id}</span>)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
