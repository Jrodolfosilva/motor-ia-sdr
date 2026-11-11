// Lista de agentes: cada um é uma configuração do mesmo motor (um segmento, um cliente, um template).
// Criar: em branco ou a partir de outro agente, escolhendo quais partes do fluxo copiar.
import { useEffect, useMemo, useState } from 'react';
import { Bot, MessageCircle, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { api, type AgentSummary, type KitSection } from './api';
import PublicLinkCard from './PublicLinkCard';

export default function Agents({ current, onOpen }: {
  current: string;
  /** Abre o agente na aba indicada (e torna ele o agente atual do painel). */
  onOpen: (key: string, tab: 'agent' | 'sim') => void;
}) {
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [sections, setSections] = useState<KitSection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = () =>
    api.listAgents().then((r) => { setAgents(r.agents); setSections(r.sections); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const remove = async (a: AgentSummary) => {
    if (!window.confirm(`Excluir o agente "${a.name}"? A configuração e as mídias dele somem e o link público para de funcionar. Não dá para desfazer.`)) return;
    try {
      await api.deleteAgent(a.key);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!agents) return <div className="editor-loading">{error ? `Erro: ${error}` : 'Carregando agentes…'}</div>;

  const sorted = [...agents].sort((a, b) => Number(b.template) - Number(a.template));

  return (
    <div className="agents">
      <div className="agents-bar">
        <span className="muted">{agents.length} {agents.length === 1 ? 'agente' : 'agentes'} · mesmo motor, configurações diferentes</span>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setCreating((v) => !v)}><Plus size={16} /> Novo agente</button>
      </div>
      {error && <div className="alert danger">{error}</div>}

      {creating && (
        <NewAgent
          agents={agents}
          sections={sections}
          onCancel={() => setCreating(false)}
          onCreated={(key) => { setCreating(false); load(); onOpen(key, 'agent'); }}
        />
      )}

      <div className="agent-grid">
        {sorted.map((a) => (
          <section key={a.key} className={`card agent-card${a.key === current ? ' current' : ''}`}>
            <div className="agent-head">
              <span className="stat-icon"><Bot size={18} strokeWidth={1.8} /></span>
              <div className="agent-name">
                <strong>{a.name}</strong>
                <small><code>{a.key}</code>{a.category ? ` · ${a.category}` : ''}</small>
              </div>
              {a.template && <span className="badge warning"><Star size={12} /> template</span>}
              {a.key === current && <span className="badge success">aberto</span>}
            </div>
            <PublicLinkCard
              compact
              agentKey={a.key}
              link={a.publicLink}
              onChange={(l) => setAgents((list) => list && list.map((x) => (x.key === a.key ? { ...x, publicLink: l } : x)))}
            />
            <div className="row">
              <button className="btn small primary" onClick={() => onOpen(a.key, 'agent')}><Pencil size={14} /> Editar</button>
              <button className="btn small" onClick={() => onOpen(a.key, 'sim')}><MessageCircle size={14} /> Simular</button>
              <div className="spacer" />
              <button className="btn small danger-btn" onClick={() => remove(a)} disabled={agents.length <= 1} title="Excluir"><Trash2 size={14} /></button>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function NewAgent({ agents, sections, onCancel, onCreated }: {
  agents: AgentSummary[];
  sections: KitSection[];
  onCancel: () => void;
  onCreated: (key: string) => void;
}) {
  const firstTemplate = agents.find((a) => a.template)?.key ?? '';
  const [name, setName] = useState('');
  const [from, setFrom] = useState<string>(firstTemplate);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(sections.map((s) => s.id)));
  const [template, setTemplate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const templates = useMemo(() => agents.filter((a) => a.template), [agents]);
  const others = useMemo(() => agents.filter((a) => !a.template), [agents]);

  const toggle = (id: string) => setPicked((p) => {
    const n = new Set(p);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const cfg = await api.createAgent({ name, from: from || null, sections: from ? [...picked] : undefined, template });
      onCreated(cfg.key);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card new-agent">
      <div className="card-head">
        <div>
          <h2>Novo agente</h2>
          <p>Comece em branco ou use outro agente como base. Com base, escolha quais partes do fluxo vêm prontas; o resto começa vazio para você configurar.</p>
        </div>
      </div>
      <div className="grid2">
        <label className="f">
          <span>Nome</span>
          <input autoFocus value={name} placeholder="Ex: SDR Auxílio-Doença" onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="f">
          <span>Base</span>
          <select value={from} onChange={(e) => setFrom(e.target.value)}>
            <option value="">Em branco</option>
            {templates.length > 0 && (
              <optgroup label="Templates">
                {templates.map((a) => <option key={a.key} value={a.key}>{a.name}</option>)}
              </optgroup>
            )}
            {others.length > 0 && (
              <optgroup label="Outros agentes">
                {others.map((a) => <option key={a.key} value={a.key}>{a.name}</option>)}
              </optgroup>
            )}
          </select>
        </label>
      </div>

      {from && (
        <>
          <div className="form-sub">
            Partes copiadas da base
            <button type="button" className="link-btn" onClick={() => setPicked(new Set(sections.map((s) => s.id)))}>todas</button>
            <button type="button" className="link-btn" onClick={() => setPicked(new Set())}>nenhuma</button>
          </div>
          <div className="section-picks">
            {sections.map((s) => (
              <label key={s.id} className="f-check">
                <input type="checkbox" checked={picked.has(s.id)} onChange={() => toggle(s.id)} /> {s.label}
              </label>
            ))}
          </div>
          <p className="muted">Modelos de IA, limites e ritmo das mensagens sempre vêm da base. Mídias da base são copiadas junto.</p>
        </>
      )}

      <label className="f-check">
        <input type="checkbox" checked={template} onChange={(e) => setTemplate(e.target.checked)} /> Marcar como template (aparece primeiro como base para novos agentes)
      </label>

      {error && <div className="alert danger">{error}</div>}
      <div className="row">
        <button className="btn primary" disabled={busy || !name.trim()} onClick={submit}>{busy ? 'Criando…' : 'Criar agente'}</button>
        <button className="btn" onClick={onCancel} disabled={busy}>Cancelar</button>
      </div>
    </section>
  );
}
