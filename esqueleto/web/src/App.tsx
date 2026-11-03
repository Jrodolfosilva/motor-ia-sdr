import { useEffect, useState } from 'react';
import { Activity, Bot, Calculator, LogOut, MessageCircle, Menu, X } from 'lucide-react';
import Simulator from './Simulator';
import Login from './Login';
import { api, type AuthUser } from './api';
import AgentEditor from './AgentEditor';
import CostEstimator from './CostEstimator';

type Tab = 'sim' | 'agent' | 'costs';

const fromHash = (): Tab => (location.hash === '#agente' ? 'agent' : location.hash === '#custos' ? 'costs' : 'sim');

const NAV: { id: Tab; label: string; hash: string; icon: typeof Bot }[] = [
  { id: 'sim', label: 'Simulador', hash: 'simulador', icon: MessageCircle },
  { id: 'agent', label: 'Agente', hash: 'agente', icon: Bot },
  { id: 'costs', label: 'Custos', hash: 'custos', icon: Calculator },
];

const TITLES: Record<Tab, { title: string; sub: string }> = {
  sim: { title: 'Simulador', sub: 'Converse como se fosse o lead e acompanhe o que o motor faz a cada turno.' },
  agent: { title: 'Configuração do agente', sub: 'Prompt, roteiro, regras de classificação e mensagens. Salvar aplica na hora.' },
  costs: { title: 'Custos', sub: 'Quanto custa atender N conversas com o agente atual, em reais.' },
};

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

  useEffect(() => {
    const onHash = () => { setTab(fromHash()); setMenuOpen(false); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

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
        <nav className="sidenav">
          {NAV.map(({ id, label, hash, icon: Icon }) => (
            <a key={id} href={`#${hash}`} className={tab === id ? 'active' : ''}>
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
          {/* simulador fica montado para não perder a conversa ao trocar de aba */}
          <div hidden={tab !== 'sim'}><Simulator /></div>
          {tab === 'agent' && <AgentEditor />}
          {tab === 'costs' && <CostEstimator />}
        </main>
      </div>
    </div>
  );
}
