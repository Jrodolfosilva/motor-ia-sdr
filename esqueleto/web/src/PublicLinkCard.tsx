// Link público de teste de um agente: liga/desliga, copia a URL e gera uma URL nova.
// Salva na hora (não depende do "Salvar" do editor).
import { useState } from 'react';
import { Check, Copy, ExternalLink, Link2, RefreshCw } from 'lucide-react';
import { api, publicLinkUrl, type PublicLink } from './api';

export default function PublicLinkCard({ agentKey, link, onChange, compact = false }: {
  agentKey: string;
  link: PublicLink;
  onChange: (l: PublicLink) => void;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = link.token ? publicLinkUrl(link.token) : null;

  const update = async (body: { enabled?: boolean; regenerate?: boolean }) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await api.setPublicLink(agentKey, body));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Não consegui copiar. Selecione o link e copie manualmente.');
    }
  };

  return (
    <div className={`plink${compact ? ' compact' : ''}`}>
      <label className="switch">
        <input type="checkbox" checked={link.enabled} disabled={busy} onChange={(e) => update({ enabled: e.target.checked })} />
        <span className="switch-track"><span /></span>
        <span className="switch-label">
          <Link2 size={15} /> Link público {link.enabled ? <span className="badge success">ativo</span> : <span className="badge neutral">desligado</span>}
        </span>
      </label>
      {!compact && (
        <p className="muted plink-hint">
          Quem tiver o link conversa com este agente sem login, sem ver prompts nem configurações (com limite de uso por IP).
          Desligar bloqueia o link e as conversas abertas por ele na hora.
        </p>
      )}
      {link.enabled && url && (
        <div className="plink-url">
          <input readOnly value={url} onFocus={(e) => e.target.select()} />
          <button className="btn small" onClick={copy} title="Copiar">{copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copiado' : 'Copiar'}</button>
          <a className="btn small" href={url} target="_blank" rel="noreferrer" title="Abrir"><ExternalLink size={14} /></a>
          {!compact && (
            <button className="btn small" disabled={busy} onClick={() => update({ regenerate: true })} title="O link antigo para de funcionar">
              <RefreshCw size={14} /> Gerar novo link
            </button>
          )}
        </div>
      )}
      {error && <div className="err">{error}</div>}
    </div>
  );
}
