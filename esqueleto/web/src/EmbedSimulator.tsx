// Simulador para embutir em qualquer página (script de embed). Só o celular + escolha do tipo de
// lead e "Recomeçar". Sem painéis internos (estado, prompts, custos) - é a visão do cliente.
import { useEffect, useRef, useState } from 'react';
import { RotateCcw, Users, Zap } from 'lucide-react';
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

export default function EmbedSimulator({ options }: { options: EmbedOptions }) {
  const [lead, setLead] = useState<LeadKind>(options.lead ?? 'form');
  const [name, setName] = useState('');
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
    setError(msg.startsWith('404') ? 'Esta conversa expirou. Clique em "Recomeçar".' : msg);
  };

  const start = async (kind: LeadKind = lead, tl: TestLead | null = testLead) => {
    setStarting(true);
    setError(null);
    try {
      const custom: Record<string, string> = kind === 'form'
        ? { ...(tl?.form_answers ?? {}), ...(options.form ?? {}), ...(name.trim() ? { nome: name.trim() } : {}) }
        : {};
      // lead de formulário sem nenhum dado vira lead frio: garante ao menos um campo
      if (kind === 'form' && !Object.keys(custom).length) custom.nome = 'Cliente';
      setSession(await api.create({ token: options.token }, options.phone ?? '5511999999999', custom));
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
        start(lead, a.test_lead);
      })
      .catch(fail);
  }, []);

  useEffect(() => {
    if (!session?.id) return;
    return api.stream(session.id, setSession);
  }, [session?.id]);

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
      <div className="embed-bar">
        {options.showLeadSwitch !== false && (
          <div className="seg embed-seg">
            <button className={lead === 'form' ? 'on' : ''} onClick={() => { setLead('form'); start('form'); }} disabled={starting}>
              <Zap size={14} /> Veio do formulário
            </button>
            <button className={lead === 'frio' ? 'on' : ''} onClick={() => { setLead('frio'); start('frio'); }} disabled={starting}>
              <Users size={14} /> Chegou sem dados
            </button>
          </div>
        )}
        {lead === 'form' && (
          <input className="embed-name" placeholder="Seu nome (opcional)" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && start('form')} />
        )}
        <button className="btn small" onClick={() => start()} disabled={starting}><RotateCcw size={14} /> Recomeçar</button>
      </div>

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
      {error && <div className="alert danger embed-error">{error}</div>}
      <div className="embed-foot">Simulação de atendimento · as mensagens não vão para o WhatsApp</div>
    </div>
  );
}
