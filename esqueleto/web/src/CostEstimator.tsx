import { useEffect, useMemo, useState } from 'react';
import { Calculator, FileText, Mic, MessageSquare, RefreshCw } from 'lucide-react';
import { brl, usd } from './CostPanel';

interface Price { input: number; output: number; cached_input: number; per_minute: number }
interface Baseline {
  fx: { rate: number; source: string; quotedAt: string | null };
  prices: { loadedAt: string | null; error: string | null };
  models: Record<'extractor' | 'responder' | 'vision' | 'transcription', { model: string; price: Price | null }>;
  averages: Record<'extractor' | 'responder' | 'vision', { input: number; output: number }>;
  reference: { label: string; leadTurns: number; aiReplies: number; files: number; audioMinutes: number };
}

const nf = (n: number, d = 0) => n.toLocaleString('pt-BR', { maximumFractionDigits: d });

type ProfileId = 'pre' | 'medido' | 'completo';
interface Profile { id: ProfileId; label: string; hint: string; leadTurns: number; aiReplies: number; files: number; audioMin: number }

/** Perfis de conversa. "medido" = conversa real da Mariane; os outros derivam dela. */
const PROFILES: Profile[] = [
  { id: 'pre', label: 'Só pré-qualificação', hint: 'Confirma os dados do formulário e a data de saída, classifica e passa para a equipe. Sem documentos.', leadTurns: 4, aiReplies: 3, files: 0, audioMin: 0 },
  { id: 'medido', label: 'Pré + documentos', hint: 'Medido na conversa real: confirma dados, recebe CTPS e comprovante da gestação, coleta contatos e passa para a equipe.', leadTurns: 7, aiReplies: 6, files: 2, audioMin: 0 },
  { id: 'completo', label: 'Fluxo completo', hint: 'A IA também faz a parte humana (comprovante de residência, dúvidas, extrato do INSS). Estimado a partir da conversa real.', leadTurns: 9, aiReplies: 8, files: 4, audioMin: 1 },
];

const MARGINS = [0, 20, 30, 50];

/** US$ de uma chamada com os tokens médios medidos. */
const callUsd = (p: Price | null, t: { input: number; output: number }) => (p ? (t.input * p.input + t.output * p.output) / 1_000_000 : 0);

export default function CostEstimator({ agentKey }: { agentKey: string }) {
  const [base, setBase] = useState<Baseline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [conversas, setConversas] = useState(1000);
  const [profile, setProfile] = useState<ProfileId | 'custom'>('pre');
  const [margin, setMargin] = useState(30);
  const [leadTurns, setLeadTurns] = useState(PROFILES[0].leadTurns);
  const [aiReplies, setAiReplies] = useState(PROFILES[0].aiReplies);
  const [files, setFiles] = useState(PROFILES[0].files);
  const [audioMin, setAudioMin] = useState(PROFILES[0].audioMin);

  const applyProfile = (p: Profile) => {
    setProfile(p.id);
    setLeadTurns(p.leadTurns);
    setAiReplies(p.aiReplies);
    setFiles(p.files);
    setAudioMin(p.audioMin);
  };
  /** Mexeu num número à mão → perfil personalizado. */
  const custom = <T,>(set: (v: T) => void) => (v: T) => { set(v); setProfile('custom'); };

  const load = () => {
    setLoading(true);
    setError(null);
    fetch(`/api/cost/baseline?kit=${encodeURIComponent(agentKey)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((b: Baseline) => {
        setBase(b);
      })
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const reset = () => applyProfile(PROFILES.find((p) => p.id === 'medido')!);

  const calc = useMemo(() => {
    if (!base) return null;
    const m = base.models;
    const unit = {
      extractor: callUsd(m.extractor.price, base.averages.extractor),
      responder: callUsd(m.responder.price, base.averages.responder),
      vision: callUsd(m.vision.price, base.averages.vision),
      audio: m.transcription.price?.per_minute ?? 0,
    };
    // cada mensagem do lead (turno) roda o extrator; a resposta só quando a IA responde
    const parts = [
      { key: 'responder', label: 'Respostas da IA', detail: `${nf(aiReplies)} × ${m.responder.model}`, usd: aiReplies * unit.responder, icon: MessageSquare },
      { key: 'extractor', label: 'Extração de dados', detail: `${nf(leadTurns)} × ${m.extractor.model}`, usd: leadTurns * unit.extractor, icon: MessageSquare },
      { key: 'vision', label: 'Leitura de imagens/PDFs', detail: `${nf(files)} × ${m.vision.model}`, usd: files * unit.vision, icon: FileText },
      { key: 'audio', label: 'Transcrição de áudios', detail: `${nf(audioMin, 1)} min × ${m.transcription.model}`, usd: audioMin * unit.audio, icon: Mic },
    ];
    const baseUsd = parts.reduce((t, p) => t + p.usd, 0);
    const k = 1 + margin / 100;
    const perConvUsd = baseUsd * k;
    const rate = base.fx.rate;
    // os 3 perfis lado a lado (com a mesma margem), para ter noção do fluxo inteiro
    const byProfile = PROFILES.map((p) => {
      const u = (p.aiReplies * unit.responder + p.leadTurns * unit.extractor + p.files * unit.vision + p.audioMin * unit.audio) * k;
      return { ...p, perConvBrl: u * rate, totalBrl: u * rate * conversas };
    });
    return {
      unit, parts, k, baseUsd, perConvUsd, perConvBrl: perConvUsd * rate,
      totalUsd: perConvUsd * conversas, totalBrl: perConvUsd * conversas * rate, rate, byProfile,
    };
  }, [base, conversas, leadTurns, aiReplies, files, audioMin, margin]);

  if (error) return <section className="card"><div className="alert danger">Não consegui carregar os preços: {error}</div></section>;
  if (!base || !calc) return <section className="card"><p className="empty">Carregando preços do Together…</p></section>;

  const missing = Object.values(base.models).filter((x) => !x.price).map((x) => x.model);

  return (
    <div className="estimator">
      <section className="card est-main">
        <div className="card-head">
          <div>
            <h2>Quanto custam as conversas</h2>
            <p>Com base numa conversa real medida no motor. Preços oficiais do Together e câmbio do dia.</p>
          </div>
          <button className="btn small" onClick={load} disabled={loading}><RefreshCw size={14} /> Atualizar preços</button>
        </div>

        <label className="est-input">
          <span>Número de conversas</span>
          <input
            type="number"
            min={0}
            step={1}
            value={Number.isFinite(conversas) ? conversas : ''}
            onChange={(e) => setConversas(Math.max(0, Number(e.target.value) || 0))}
            autoFocus
          />
        </label>
        <div className="est-presets">
          {[100, 500, 1000, 5000, 10000].map((n) => (
            <button key={n} className={`chip${conversas === n ? ' on' : ''}`} onClick={() => setConversas(n)}>{nf(n)}</button>
          ))}
        </div>

        <div className="f">
          <span>Tipo de conversa</span>
          <div className="est-profiles">
            {PROFILES.map((p) => (
              <button key={p.id} className={profile === p.id ? 'on' : ''} onClick={() => applyProfile(p)}>
                <strong>{p.label}</strong>
                <small>{brl(calc.byProfile.find((x) => x.id === p.id)!.perConvBrl)} / conversa</small>
              </button>
            ))}
          </div>
          <small>{profile === 'custom' ? 'Personalizado (ajustado em "Perfil da conversa").' : PROFILES.find((p) => p.id === profile)!.hint}</small>
        </div>

        <div className="f">
          <span>Margem de segurança (para cima)</span>
          <div className="seg seg-4">
            {MARGINS.map((m) => (
              <button key={m} className={margin === m ? 'on' : ''} onClick={() => setMargin(m)}>{m === 0 ? 'Sem margem' : `+${m}%`}</button>
            ))}
          </div>
          <small>Cobre conversas mais longas (o histórico cresce a cada turno), respostas refeitas quando o lead interrompe e variação dos tokens de raciocínio.</small>
        </div>

        <div className="est-result">
          <div>
            <span className="est-label">Custo total{margin ? ` (com +${margin}%)` : ''}</span>
            <strong>{brl(calc.totalBrl)}</strong>
            <span className="est-usd">{usd(calc.totalUsd)}{margin ? ` · sem margem ${brl(calc.baseUsd * conversas * calc.rate)}` : ''}</span>
          </div>
          <div>
            <span className="est-label">Por conversa</span>
            <strong className="est-small">{brl(calc.perConvBrl)}</strong>
            <span className="est-usd">{usd(calc.perConvUsd)}</span>
          </div>
        </div>
        <div className="est-fx">US$ 1 = R$ {calc.rate.toLocaleString('pt-BR', { minimumFractionDigits: 4 })} · {base.fx.source}</div>
        {missing.length > 0 && <div className="cost-warn">Sem preço no Together para: {missing.join(', ')} (contado como R$ 0).</div>}
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>Comparando os fluxos</h2>
            <p>{nf(conversas)} conversas{margin ? `, com +${margin}% de margem` : ''}.</p>
          </div>
        </div>
        <table className="cost-table">
          <thead><tr><th>Fluxo</th><th className="num">Por conversa</th><th className="num">Total</th></tr></thead>
          <tbody>
            {calc.byProfile.map((p) => (
              <tr key={p.id} className={profile === p.id ? 'est-row-on' : ''}>
                <td>{p.label}<span className="cost-model">{p.leadTurns} msgs do lead · {p.aiReplies} respostas · {p.files} arquivos{p.audioMin ? ` · ${p.audioMin} min de áudio` : ''}</span></td>
                <td className="num">{brl(p.perConvBrl)}</td>
                <td className="num">{brl(p.totalBrl)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>De onde vem o custo</h2>
            <p>Para {nf(conversas)} conversas.</p>
          </div>
        </div>
        <table className="cost-table">
          <thead><tr><th>Etapa</th><th className="num">Por conversa</th><th className="num">Total</th><th className="num">%</th></tr></thead>
          <tbody>
            {calc.parts.map((p) => (
              <tr key={p.key}>
                <td>{p.label}<span className="cost-model">{p.detail}</span></td>
                <td className="num">{brl(p.usd * calc.k * calc.rate)}</td>
                <td className="num">{brl(p.usd * calc.k * calc.rate * conversas)}</td>
                <td className="num">{calc.baseUsd ? nf((p.usd / calc.baseUsd) * 100) : 0}%</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><td>Total</td><td className="num">{brl(calc.perConvBrl)}</td><td className="num">{brl(calc.totalBrl)}</td><td className="num">100%</td></tr>
          </tfoot>
        </table>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>Perfil da conversa</h2>
            <p>Números do fluxo escolhido. Mexer aqui vira "personalizado".</p>
          </div>
          <button className="btn small" onClick={reset}><Calculator size={14} /> Conversa real medida</button>
        </div>
        <div className="grid2">
          <label className="f"><span>Mensagens do lead (turnos)</span>
            <input type="number" min={0} value={leadTurns} onChange={(e) => custom(setLeadTurns)(Math.max(0, Number(e.target.value) || 0))} />
            <small>Cada uma roda o extrator: {usd(calc.unit.extractor)} ({nf(base.averages.extractor.input)} tokens de entrada, {nf(base.averages.extractor.output)} de saída)</small>
          </label>
          <label className="f"><span>Respostas da IA</span>
            <input type="number" min={0} value={aiReplies} onChange={(e) => custom(setAiReplies)(Math.max(0, Number(e.target.value) || 0))} />
            <small>Cada uma: {usd(calc.unit.responder)} ({nf(base.averages.responder.input)} entrada, {nf(base.averages.responder.output)} saída)</small>
          </label>
          <label className="f"><span>Imagens/PDFs enviados pelo lead</span>
            <input type="number" min={0} value={files} onChange={(e) => custom(setFiles)(Math.max(0, Number(e.target.value) || 0))} />
            <small>Cada leitura: {usd(calc.unit.vision)}. Imagens que o escritório envia não custam.</small>
          </label>
          <label className="f"><span>Minutos de áudio do lead</span>
            <input type="number" min={0} step={0.5} value={audioMin} onChange={(e) => custom(setAudioMin)(Math.max(0, Number(e.target.value) || 0))} />
            <small>{usd(calc.unit.audio)} por minuto. A resposta ao áudio já conta em "Respostas da IA".</small>
          </label>
        </div>
      </section>
    </div>
  );
}
