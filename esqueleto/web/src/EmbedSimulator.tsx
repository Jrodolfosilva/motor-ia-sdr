// Simulador para embutir em qualquer página (script de embed / link público /t/<token>).
// Celular de um lado, configuração do teste do outro: tipo de lead (formulário ou sem dados), telefone
// e, para lead de formulário, as respostas que chegam do form (editáveis). Sem painéis internos
// (estado, prompts, custos) - é a visão do cliente.
import { useEffect, useRef, useState } from 'react';
import { Play, Plus, RotateCcw, Users, X, Zap } from 'lucide-react';
import { api, setKitKey, type RequiredDocument, type Session, type TestLead } from './api';
import Phone, { COLD_LEAD_DRAFT } from './Phone';

type LeadKind = 'form' | 'frio';

export interface EmbedOptions {
  /** Token do link público do agente. */
  token: string;
  /** Tipo de lead inicial. */
  lead?: LeadKind;
  /** Mostrar a escolha formulário/frio. */
  showLeadSwitch?: boolean;
  /** Respostas do formulário simulado (lead de formulário). */
  form?: Record<string, string>;
  /** Telefone (DDD define o estado citado na recepção). */
  phone?: string;
  /** Texto acima do celular. */
  title?: string;
}

/** Campo do formulário de teste. `fixed` = pergunta do roteiro ou do lead de teste (rótulo não muda). */
interface FormRow { id: string; question: string; value: string; fixed: boolean }

const DEFAULT_PHONE = '5511999999999';

function initialRows(fields: { key: string; label: string }[], tl: TestLead | null, extra?: Record<string, string>): FormRow[] {
  const rows: FormRow[] = fields.map((f) => ({ id: f.key, question: f.label, value: '', fixed: true }));
  for (const [q, v] of Object.entries({ ...(tl?.form_answers ?? {}), ...(extra ?? {}) })) {
    const same = rows.find((r) => r.id === q || r.question === q);
    if (same) same.value = v;
    else rows.push({ id: q, question: q, value: v, fixed: true });
  }
  return rows;
}

export default function EmbedSimulator({ options }: { options: EmbedOptions }) {
  const [lead, setLead] = useState<LeadKind>(options.lead ?? 'form');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState(options.phone ?? DEFAULT_PHONE);
  const [rows, setRows] = useState<FormRow[]>([]);
  const [dirty, setDirty] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [agentName, setAgentName] = useState('Atendimento');
  const [docs, setDocs] = useState<RequiredDocument[]>([]);
  const [testLead, setTestLead] = useState<TestLead | null>(null);
  const [off, setOff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const started = useRef(false);
  const [kicking, setKicking] = useState(false);
  useEffect(() => setKicking(false), [session?.id]);

  const fail = (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    if (/desativado/i.test(msg)) setOff(true);
    setError(msg.startsWith('404') ? 'Esta conversa expirou. Clique em "Iniciar nova conversa".' : msg);
  };

  const customFields = (kind: LeadKind, formRows: FormRow[]): Record<string, string> => {
    if (kind === 'frio') return {};
    const out: Record<string, string> = {};
    if (name.trim()) out.nome = name.trim();
    for (const r of formRows) {
      const q = r.id.trim() || r.question.trim();
      if (q && r.value.trim()) out[q] = r.value.trim();
    }
    // lead de formulário sem nenhum dado vira lead frio: garante ao menos um campo
    if (!Object.keys(out).length) out.nome = 'Cliente';
    return out;
  };

  const start = async (kind: LeadKind = lead, formRows: FormRow[] = rows) => {
    setStarting(true);
    setError(null);
    try {
      setSession(await api.create({ token: options.token }, phone.replace(/\D/g, '') || DEFAULT_PHONE, customFields(kind, formRows)));
      setDirty(false);
    } catch (e) {
      fail(e);
    } finally {
      setStarting(false);
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!options.token) {
      setOff(true);
      setError('Link de teste inválido (faltou o token).');
      return;
    }
    api.getPublicAgent(options.token)
      .then((a) => {
        setKitKey(a.key);
        setAgentName(a.name);
        setDocs(a.documents);
        setTestLead(a.test_lead);
        const r = initialRows(a.fields ?? [], a.test_lead, options.form);
        setRows(r);
        start(lead, r);
      })
      .catch(fail);
  }, []);

  useEffect(() => {
    if (!session?.id) return;
    return api.stream(session.id, setSession);
  }, [session?.id]);

  const edit = <T,>(set: (v: T) => void) => (v: T) => { set(v); setDirty(true); };
  const setRow = (i: number, patch: Partial<FormRow>) => {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    setDirty(true);
  };
  const switchLead = (kind: LeadKind) => {
    if (kind === lead) return;
    setLead(kind);
    start(kind);
  };

  const optimistic = (m: Session['messages'][number]) =>
    setSession((s) => (s ? { ...s, messages: [...s.messages, m] } : s));
  // conversa ainda vazia: lead frio já vem com a 1ª mensagem escrita; lead de formulário tem "Iniciar"
  const hasForm = Object.keys(session?.customFields ?? {}).length > 0;
  const untouched = !!session && session.messages.length === 0 && (session.state.turnsCount ?? 0) === 0;
  const kick = () => {
    if (!session) return;
    setKicking(true);
    api.start(session.id).catch(fail);
  };
  const tmp = () => ({ id: `tmp-${Date.now()}`, role: 'user' as const, createdAt: new Date().toISOString() });

  if (off) {
    return (
      <div className="hub-embed">
        <div className="alert danger embed-error">{error ?? 'Este link de teste foi desativado.'}</div>
      </div>
    );
  }

  return (
    <div className="hub-embed">
      {options.title && <div className="embed-title">{options.title}</div>}
      <div className="embed-split">
        <div className="embed-phone">
          <Phone
            key={session?.id}
            draft={untouched && !hasForm ? testLead?.cold_message || COLD_LEAD_DRAFT : ''}
            startButton={untouched && hasForm ? { label: kicking ? 'Iniciando…' : 'Iniciar', disabled: kicking, onClick: kick } : null}
            contactName={agentName}
            messages={session?.messages ?? []}
            typing={session?.typing || false}
            closed={!!session && session.state.status !== 'active'}
            documents={docs}
            onSend={(body) => {
              if (!session) return;
              optimistic({ ...tmp(), type: 'text', body });
              api.send(session.id, body).catch(fail);
            }}
            onSendFile={(file, caption) => {
              if (!session) return;
              const type = file.type === 'application/pdf' ? 'document' : file.type.startsWith('video/') ? 'video' : 'image';
              optimistic({ ...tmp(), type, body: caption, fileName: file.name });
              api.sendFile(session.id, file, caption).catch(fail);
            }}
            onSendAudio={(audio) => {
              if (!session) return;
              optimistic({ ...tmp(), type: 'audio', body: '', transcribing: true });
              api.sendAudio(session.id, audio).catch(fail);
            }}
          />
          <div className="embed-foot">Simulação de atendimento · as mensagens não vão para o WhatsApp</div>
        </div>

        <aside className="embed-panel">
          <div className="embed-panel-head">
            <strong>Configurar o teste</strong>
            <small>Escolha como o cliente chega. Mudou algo? Inicie uma nova conversa para valer.</small>
          </div>

          {options.showLeadSwitch !== false && (
            <div className="seg embed-seg">
              <button className={lead === 'form' ? 'on' : ''} onClick={() => switchLead('form')} disabled={starting}>
                <Zap size={14} /> Veio do formulário
              </button>
              <button className={lead === 'frio' ? 'on' : ''} onClick={() => switchLead('frio')} disabled={starting}>
                <Users size={14} /> Chegou sem dados
              </button>
            </div>
          )}
          <p className="embed-hint">
            {lead === 'form'
              ? 'O cliente preencheu um formulário (anúncio ou site). A IA abre a conversa, confirma estes dados e segue o atendimento. Clique em "Iniciar" no celular.'
              : 'O cliente mandou mensagem sem nenhum dado. A IA faz o atendimento completo. A primeira mensagem já está escrita no celular: é só enviar.'}
          </p>

          <label className="embed-field">
            <span>Telefone com DDD</span>
            <input value={phone} inputMode="tel" onChange={(e) => edit(setPhone)(e.target.value)} />
          </label>

          {lead === 'form' && (
            <>
              <label className="embed-field">
                <span>Nome</span>
                <input value={name} placeholder="Ex: Maria" onChange={(e) => edit(setName)(e.target.value)} />
              </label>
              <div className="embed-sub">Respostas do formulário</div>
              {rows.map((r, i) => (
                <div key={i} className="embed-row">
                  {r.fixed
                    ? <span className="embed-q">{r.question}</span>
                    : <input className="embed-q-input" value={r.question} placeholder="Pergunta" onChange={(e) => setRow(i, { question: e.target.value, id: e.target.value })} />}
                  <div className="embed-row-input">
                    <input value={r.value} placeholder="Deixe vazio se o form não pergunta" onChange={(e) => setRow(i, { value: e.target.value })} />
                    {!r.fixed && (
                      <button className="icon-btn" aria-label="Remover campo" onClick={() => { setRows((rs) => rs.filter((_, j) => j !== i)); setDirty(true); }}>
                        <X size={14} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
              <button className="btn small embed-add" onClick={() => { setRows((rs) => [...rs, { id: '', question: '', value: '', fixed: false }]); setDirty(true); }}>
                <Plus size={14} /> Outro campo
              </button>
            </>
          )}

          <button className={`btn ${dirty ? 'primary' : ''} embed-go`} onClick={() => start()} disabled={starting}>
            {dirty ? <Play size={15} /> : <RotateCcw size={15} />}
            {starting ? 'Iniciando…' : dirty ? 'Iniciar nova conversa com esses dados' : 'Recomeçar conversa'}
          </button>
          {error && <div className="alert danger">{error}</div>}
        </aside>
      </div>
    </div>
  );
}
