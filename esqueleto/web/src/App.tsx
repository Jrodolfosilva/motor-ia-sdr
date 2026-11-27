import { useEffect, useState } from 'react';
import { BarChart3, Bot, Calculator, Layers, LogOut, MessageCircle, Menu, X } from 'lucide-react';
import Simulator from './Simulator';
import Login from './Login';
import { api, setKitKey, type AgentSummary, type AuthUser } from './api';
import AgentEditor from './AgentEditor';
import Agents from './Agents';
import CostEstimator from './CostEstimator';
import CostReport from './CostReport';

type Tab = 'agents' | 'sim' | 'agent' | 'costs' | 'report';

const HASH: Record<Tab, string> = { agents: 'agentes', sim: 'simulador', agent: 'agente', costs: 'custos', report: 'relatorio' };
const fromHash = (): Tab => (Object.entries(HASH).find(([, h]) => `#${h}` === location.hash)?.[0] as Tab | undefined) ?? 'agents';

const NAV: { id: Tab; label: string; icon: typeof Bot }[] = [
  { id: 'agents', label: 'Agentes', icon: Layers },
  { id: 'sim', label: 'Simulador', icon: MessageCircle },
  { id: 'agent', label: 'Configuração', icon: Bot },
  { id: 'costs', label: 'Custos', icon: Calculator },
  { id: 'report', label: 'Relatório', icon: BarChart3 },
];

const TITLES: Record<Tab, { title: string; sub: string }> = {
  agents: { title: 'Agentes', sub: 'Um motor, vários agentes: cada segmento ou cliente tem a própria configuração e o próprio link de teste.' },
  sim: { title: 'Simulador', sub: 'Converse como se fosse o lead e acompanhe o que o motor faz a cada turno.' },
  agent: { title: 'Configuração do agente', sub: 'Prompt, roteiro, regras de classificação, mensagens e link público. Salvar aplica na hora.' },
  costs: { title: 'Custos', sub: 'Quanto custa atender N conversas com o agente atual, em reais.' },
  report: { title: 'Relatório', sub: 'Conversas reais por período: custo da IA, mensagens enviadas e quantas foram qualificadas ou desqualificadas.' },
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
  if (!user) return <Login onLogin={(u) => { location.hash = HASH.agents; setUser(u); }} />;
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

  const current = agents.find((a) => a.key === agentKey);

  const open = (key: string, t: Tab) => {
    selectAgent(key);
    location.hash = HASH[t];
  };

  return (
    <div className={`shell${menuOpen ? ' menu-open' : ''}`}>
      <header className="topbar">
        <div className="topbar-inner">
        <a className="logo" href={`#${HASH.agents}`} title="Agentes · v1.01" aria-label="Agentes">
          <Bot className="logo-bot" strokeWidth={1.6} />
        </a>
        <button className="icon-btn menu-btn" onClick={() => setMenuOpen((v) => !v)} aria-label="Menu">
          {menuOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
        <nav className="topnav">
          {NAV.map(({ id, label, icon: Icon }) => (
            <a key={id} href={`#${HASH[id]}`} className={tab === id ? 'active' : ''}>
              <Icon size={17} strokeWidth={1.9} />
              {label}
            </a>
          ))}
        </nav>
        <div className="topbar-right">
          <div className="user-chip">
            <span className="user-avatar">{initials(user.name)}</span>
            <span className="user-meta">
              <strong>{user.name}</strong>
              <small>{user.email}</small>
            </span>
            <button className="icon-btn" onClick={onLogout} aria-label="Sair" title="Sair"><LogOut size={16} /></button>
          </div>
        </div>
        </div>
      </header>

      <div className="content">
        <main className="main">
          <section className="card hero">
            <h1>{TITLES[tab].title}</h1>
            <p>{TITLES[tab].sub}</p>
          </section>
          {tab !== 'agents' && current && (
            <div className="current-agent">
              <span>Agente: <strong>{current.name}</strong>{current.template ? ' (template)' : ''}</span>
              <a href={`#${HASH.agents}`}>trocar</a>
            </div>
          )}
          {tab === 'agents' && <Agents current={agentKey} onOpen={open} />}
          {agentKey && (
            <>
              {/* simulador fica montado para não perder a conversa ao trocar de aba (key: um por agente) */}
              <div hidden={tab !== 'sim'}><Simulator key={agentKey} agentKey={agentKey} /></div>
              {tab === 'agent' && <AgentEditor key={agentKey} agentKey={agentKey} onSaved={refreshAgents} />}
              {tab === 'costs' && <CostEstimator key={agentKey} agentKey={agentKey} />}
              {tab === 'report' && <CostReport key={agentKey} agentKey={agentKey} />}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
