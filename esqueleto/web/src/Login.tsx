// Tela de login do painel: e-mail + código de 6 dígitos do app autenticador.
import { FormEvent, useState } from 'react';
import { Activity, KeyRound } from 'lucide-react';
import { api, type AuthUser } from './api';

export default function Login({ onLogin }: { onLogin: (u: AuthUser) => void }) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLogin(await api.login(email.trim(), code));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <form className="card login-card" onSubmit={submit}>
        <div className="login-logo">
          <span className="logo-mark"><Activity size={22} strokeWidth={2.2} /></span>
          <div>
            <strong>hub ia</strong>
            <small>motor de atendimento</small>
          </div>
        </div>
        <h1>Entrar</h1>
        <p className="muted">Use o código de 6 dígitos do seu app autenticador.</p>

        <label className="login-field">
          <span>E-mail</span>
          <input type="email" autoComplete="username" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="login-field">
          <span>Código do autenticador</span>
          <input
            className="login-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            required
            placeholder="000000"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          />
        </label>

        {error && <div className="alert danger">{error}</div>}
        <button className="btn primary login-btn" disabled={busy || code.length !== 6 || !email}>
          <KeyRound size={16} /> {busy ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </div>
  );
}
