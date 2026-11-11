import { useEffect, useState } from 'react';
import { Activity, Bot, Calculator, Layers, LogOut, MessageCircle, Menu, X } from 'lucide-react';
import Simulator from './Simulator';
import Login from './Login';
import { api, setKitKey, type AgentSummary, type AuthUser } from './api';
import AgentEditor from './AgentEditor';
import Agents from './Agents';
import CostEstimator from './CostEstimator';

type Tab = 'agents' | 'sim' | 'agent' | 'costs';

const HASH: Record<Tab, string> = { agents: 'agentes', sim: 'simulador', agent: 'agente', costs: 'custos' };
const fromHash = (): Tab => (Object.entries(HASH).find(([, h]) => `#${h}` === location.hash)?.[0] as Tab | undefined) ?? 'sim';

const NAV: { id: Tab; label: string; icon: typeof Bot }[] = [
  { id: 'agents', label: 'Agentes', icon: Layers },
  { id: 'sim', label: 'Simulador', icon: MessageCircle },
  { id: 'agent', label: 'Configuração', icon: Bot },
  { id: 'costs', label: 'Custos', icon: Calculator },
];

const TITLES: Record<Tab, { title: string; sub: string }> = {
  agents: { title: 'Agentes', sub: 'Um motor, vários agentes: cada segmento ou cliente tem a própria configuração e o próprio link de teste.' },
  sim: { title: 'Simulador', sub: 'Converse como se fosse o lead e acompanhe o que o motor faz a cada turno.' },
  agent: { title: 'Configuração do agente', sub: 'Prompt, roteiro, regras de classificação, mensagens e link público. Salvar aplica na hora.' },
  costs: { title: 'Custos', sub: 'Quanto custa atender N conversas com o agente atual, em reais.' },
};

// agente aberto no painel: lembrado por navegador (conveniência; sem ele cai no primeiro da lista)
const STORE = 'hub-ia:agent';
const readStored = () => { try { return localStorage.getItem(STORE) ?? ''; } catch { return ''; } };
const writeStored = (k: string) => { try { localStorage.setItem(STORE, k); } catch { /* sem storage */ } };

export default function App() {
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined); // undefined = verificando
  useEffect(() => {
    api.me().then(setUser).catch(() => setUser(null));
    const onExpired = () => setUser(null);
    window.addEventListener('hub-auth-required', onExpired);
    return () => window.removeEventListener('hub-auth-required', onExpired);
  }, []);

  if (user === undefined) return <div className="login-page" />;
  if (!user) return <Login onLogin={setUser} />;
  return <Panel user={user} onLogout={() => { api.logout().finally(() => setUser(null)); }} />;
}

const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '?';

function Panel({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>(fromHash);
  const [menuOpen, setMenuOpen] = useState(false);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [agentKey, setAgentKeyState] = useState('');

  const selectAgent = (key: string) => {
    setKitKey(key);
    writeStored(key);
    setAgentKeyState(key);
  };

  const refreshAgents = () =>
    api.listAgents().then(({ agents: list }) => {
      setAgents(list);
      const keep = [agentKey, readStored()].find((k) => k && list.some((a) => a.key === k));
      selectAgent(keep ?? list[0]?.key ?? '');
    }).catch(() => {});

  useEffect(() => {
    const onHash = () => { setTab(fromHash()); setMenuOpen(false); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // lista de agentes (nomes, link) muda quando se cria/exclui/salva: recarrega ao trocar de aba
  useEffect(() => { refreshAgents(); }, [tab]);

  const open = (key: string, t: Tab) => {
    selectAgent(key);
    location.hash = HASH[t];
  };

  return (
    <div className={`shell${menuOpen ? ' menu-open' : ''}`}>
      <aside className="sidebar">
        <div className="sidebar-glow" />
        <div className="logo">
          <span className="logo-mark"><Activity size={22} strokeWidth={2.2} /></span>
          <span className="logo-text">
            <strong>hub ia</strong>
            <small>motor de atendimento</small>
          </span>
        </div>
        {agents.length > 0 && (
          <label className="agent-picker">
            <small>Agente aberto</small>
            <select value={agentKey} onChange={(e) => selectAgent(e.target.value)}>
              {agents.map((a) => <option key={a.key} value={a.key}>{a.name}{a.template ? ' (template)' : ''}</option>)}
            </select>
          </label>
        )}
        <nav className="sidenav">
          {NAV.map(({ id, label, icon: Icon }) => (
            <a key={id} href={`#${HASH[id]}`} className={tab === id ? 'active' : ''}>
              <Icon size={18} strokeWidth={1.8} />
              {label}
            </a>
          ))}
        </nav>
        <div className="sidebar-foot">Fase 1 · simulador</div>
      </aside>
      <div className="backdrop" onClick={() => setMenuOpen(false)} />

      <div className="content">
        <header className="topbar">
          <button className="icon-btn menu-btn" onClick={() => setMenuOpen((v) => !v)} aria-label="Menu">
            {menuOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
          <div className="topbar-title">{TITLES[tab].title}</div>
          <div className="user-chip">
            <span className="user-avatar">{initials(user.name)}</span>
            <span className="user-meta">
              <strong>{user.name}</strong>
              <small>{user.email}</small>
            </span>
            <button className="icon-btn" onClick={onLogout} aria-label="Sair" title="Sair"><LogOut size={16} /></button>
          </div>
        </header>

        <main className="main">
          <section className="card hero">
            <h1>{TITLES[tab].title}</h1>
            <p>{TITLES[tab].sub}</p>
          </section>
          {tab === 'agents' && <Agents current={agentKey} onOpen={open} />}
          {agentKey && (
            <>
              {/* simulador fica montado para não perder a conversa ao trocar de aba (key: um por agente) */}
              <div hidden={tab !== 'sim'}><Simulator key={agentKey} agentKey={agentKey} /></div>
              {tab === 'agent' && <AgentEditor key={agentKey} agentKey={agentKey} onSaved={refreshAgents} />}
              {tab === 'costs' && <CostEstimator key={agentKey} agentKey={agentKey} />}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
