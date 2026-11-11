import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from 'react';
import { FileText, Image as ImageIcon, Mic, Paperclip, Send, Trash2, X } from 'lucide-react';
import { mediaUrl, type MediaAnalysis, type RequiredDocument, type SimMessage } from './api';

interface Props {
  contactName: string;
  messages: SimMessage[];
  /** false | 'typing' ("digitando…") | 'recording' ("gravando áudio…"). */
  typing: boolean | 'typing' | 'recording';
  closed: boolean;
  documents: RequiredDocument[];
  onSend: (text: string) => void;
  /** Foto ou PDF de verdade (a IA lê no turno). */
  onSendFile: (file: File, caption: string) => void;
  /** Áudio gravado no microfone ou arquivo de áudio (transcrito no servidor). */
  onSendAudio: (audio: Blob) => void;
  /** Texto já escrito na caixa de mensagem (muda quando a conversa recomeça). */
  draft?: string;
  /** No lugar da caixa de mensagem, um botão (ex: "Iniciar" para lead de formulário). */
  startButton?: { label: string; onClick: () => void; disabled?: boolean } | null;
}

const hhmm = (iso?: string) => {
  const d = iso ? new Date(iso) : new Date();
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
};

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,application/pdf,audio/*,video/*';

function eventText(m: SimMessage): string {
  const e = m.event;
  if (!e) return m.body;
  const kind = { handoff: '🤝 Passou para humano', disqualify: '🚫 Desqualificado', info: 'ℹ️' }[e.kind];
  const detail = e.message ?? e.summary ?? e.reason ?? '';
  return `${kind}${detail ? ' — ' + detail : ''}${e.classification ? ` · ${e.classification}` : ''}`;
}

function Clock() {
  const [now, setNow] = useState(hhmm());
  useEffect(() => {
    const t = setInterval(() => setNow(hhmm()), 15000);
    return () => clearInterval(t);
  }, []);
  return <span>{now}</span>;
}

/** Gravador do microfone (MediaRecorder). */
function useRecorder(onDone: (b: Blob) => void) {
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const discard = useRef(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!startedAt) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [startedAt]);

  const start = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm'].find((m) => MediaRecorder.isTypeSupported(m));
      const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunks.current = [];
      discard.current = false;
      r.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        setStartedAt(null);
        if (!discard.current && chunks.current.length) onDone(new Blob(chunks.current, { type: r.mimeType || 'audio/webm' }));
      };
      r.start();
      rec.current = r;
      setStartedAt(Date.now());
      setNow(Date.now());
    } catch (e) {
      setError((e as Error).name === 'NotAllowedError' ? 'Permita o microfone no navegador.' : `Microfone indisponível: ${(e as Error).message}`);
    }
  };
  const stop = (send: boolean) => {
    discard.current = !send;
    if (rec.current?.state === 'recording') rec.current.stop();
  };

  return { recording: startedAt !== null, seconds: startedAt ? (now - startedAt) / 1000 : 0, start, stop, error, clearError: () => setError(null) };
}

/** Prévia do arquivo escolhido no 📎, com legenda (como no WhatsApp). */
function FilePreview({ file, onCancel, onSend }: { file: File; onCancel: () => void; onSend: (caption: string) => void }) {
  const [caption, setCaption] = useState('');
  const [url] = useState(() => URL.createObjectURL(file));
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  const kind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('audio/') ? 'audio' : file.type.startsWith('video/') ? 'video' : 'pdf';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSend(caption.trim());
  };

  return (
    <form className="attach-sheet" onSubmit={submit}>
      <div className="attach-head">
        <strong>{kind === 'image' ? 'Enviar foto' : kind === 'audio' ? 'Enviar áudio' : kind === 'video' ? 'Enviar vídeo' : 'Enviar PDF'}</strong>
        <button type="button" className="attach-x" onClick={onCancel} aria-label="Cancelar"><X size={18} /></button>
      </div>
      {kind === 'image' && <img className="attach-preview-img" src={url} alt="" />}
      {kind === 'audio' && <audio controls src={url} className="attach-preview-audio" />}
      {kind === 'video' && <video controls src={url} className="attach-preview-img" />}
      {kind === 'pdf' && (
        <div className="wa-file document">
          <span className="wa-file-icon"><FileText size={20} /></span>
          <span className="wa-file-meta"><strong>{file.name}</strong><small>PDF · {(file.size / 1024).toFixed(0)} KB</small></span>
        </div>
      )}
      {kind !== 'audio' && (
        <label>
          <span>Legenda (opcional)</span>
          <input autoFocus value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="Ex: tá aqui a carteira" />
        </label>
      )}
      <small className="attach-hint">
        {kind === 'audio' ? 'O áudio é transcrito e entra na conversa como texto.' : kind === 'video' ? 'A IA não assiste vídeos: entra o bloqueio configurado em "Conduta e limites".' : 'A IA lê o arquivo de verdade (visão / texto do PDF) no próximo turno.'}
      </small>
      <button className="attach-send">Enviar</button>
    </form>
  );
}

function AnalysisLine({ m }: { m: SimMessage }) {
  const a = m.aiAnalysis;
  if (m.id.startsWith('tmp-')) return <span className="wa-ai-read pending">enviando…</span>;
  if (!a) return <span className="wa-ai-read pending">🔎 IA analisando…</span>;
  if ('failed' in a) return <span className="wa-ai-read fail">⚠️ IA não conseguiu ler este arquivo</span>;
  const ok = a as MediaAnalysis;
  return (
    <span className={`wa-ai-read${ok.legivel === false ? ' fail' : ''}`} title={ok.dados ? JSON.stringify(ok.dados, null, 1) : undefined}>
      🔎 IA leu <b>{ok.tipo}</b>: {ok.resumo}{ok.legivel === false ? ' (pouco legível)' : ''}
    </span>
  );
}

/** Primeira mensagem sugerida para o lead frio (já vem escrita na caixa). */
/** Mensagem padrão do lead frio quando o agente não define `test_lead.cold_message`. */
export const COLD_LEAD_DRAFT = 'Olá, gostaria de mais informações';

export default function Phone({ contactName, messages, typing, closed, documents, onSend, onSendFile, onSendAudio, draft, startButton }: Props) {
  const [text, setText] = useState(draft ?? '');
  useEffect(() => { setText(draft ?? ''); }, [draft]);
  const [picked, setPicked] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const mic = useRecorder(onSendAudio);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, typing]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const body = text.trim();
    if (!body) return; // pode mandar mesmo com a IA digitando: é assim que se testa a interrupção
    setText('');
    onSend(body);
    inputRef.current?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const pick = (f: File | undefined) => {
    setFileError(null);
    if (!f) return;
    const ok = /^image\/(png|jpe?g|webp|gif)$/.test(f.type) || f.type === 'application/pdf' || f.type.startsWith('audio/') || f.type.startsWith('video/');
    if (!ok) return setFileError('Envie foto (PNG/JPG/WEBP), PDF, áudio ou vídeo.');
    if (f.size > 50 * 1024 * 1024) return setFileError('Arquivo acima de 50 MB.');
    setPicked(f);
  };

  // reações não viram balão: aparecem como selo no balão do lead que foi reagido
  const reactions = new Map<string, string>();
  for (const m of messages) if (m.type === 'reaction' && m.replyTo) reactions.set(m.replyTo, m.body);

  const docLabel = (key: string) => documents.find((d) => d.key === key)?.label;
  const initials = contactName.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

  return (
    <div className="phone">
      <div className="phone-notch" />
      <div className="phone-screen">
        <div className="statusbar">
          <Clock />
          <span className="statusbar-icons">▂▄▆ 5G ▮</span>
        </div>

        <header className="wa-head">
          <span className="wa-back">‹</span>
          <div className="wa-avatar">{initials}</div>
          <div className="wa-contact">
            <strong>{contactName}</strong>
            <small>{typing === 'recording' ? 'gravando áudio…' : typing ? 'digitando…' : 'online'}</small>
          </div>
          <span className="wa-icons">📹 📞 ⋮</span>
        </header>

        <div className="wa-body">
          <div className="wa-crypto">🧪 Simulador. Nada aqui é enviado ao WhatsApp.</div>
          {messages.map((m) => {
            if (m.type === 'reaction') return null;
            if (m.role === 'event' || m.type === 'internal_note') {
              return <div key={m.id} className="wa-system">{m.event ? eventText(m) : `📝 ${m.body}`}</div>;
            }
            const mine = m.role === 'user';
            const reaction = reactions.get(m.id);
            const src = m.mediaPath ? mediaUrl(m.mediaPath) : null;
            const analysis = m.aiAnalysis && !('failed' in m.aiAnalysis) ? (m.aiAnalysis as MediaAnalysis) : null;
            return (
              <div key={m.id} className={`wa-row ${mine ? 'out' : 'in'}`}>
                <div className={`wa-bubble ${mine ? 'out' : 'in'}${reaction ? ' has-reaction' : ''}${m.type === 'image' || m.type === 'document' ? ' file' : ''}`}>
                  {m.type === 'image' && (src
                    ? <a href={src} target="_blank" rel="noreferrer"><img className="wa-img" src={src} alt="" /></a>
                    : <div className="wa-file"><span className="wa-file-icon"><ImageIcon size={20} /></span><span className="wa-file-meta"><strong>Foto</strong></span></div>)}
                  {m.type === 'document' && (
                    <a className="wa-file document" href={src ?? undefined} target="_blank" rel="noreferrer">
                      <span className="wa-file-icon"><FileText size={20} /></span>
                      <span className="wa-file-meta">
                        <strong>{m.fileName ?? (analysis && docLabel(analysis.tipo)) ?? 'Documento'}</strong>
                        <small>PDF</small>
                      </span>
                    </a>
                  )}
                  {(m.type === 'image' || m.type === 'document') && mine && <AnalysisLine m={m} />}

                  {m.type === 'audio' && src && <audio className="wa-audio" controls preload="metadata" src={src} />}
                  {m.type === 'audio' && mine && (
                    <span className="wa-transcript-in">
                      {m.transcribing || m.id.startsWith('tmp-') ? 'transcrevendo…' : m.transcript ? `📝 ${m.transcript}` : '⚠️ sem transcrição'}
                    </span>
                  )}
                  {m.type === 'video' && src && <video className="wa-video" controls preload="metadata" src={src} />}
                  {(m.type === 'audio' || m.type === 'video') && !mine && m.transcript && (
                    <details className="wa-transcript"><summary>o que diz</summary>{m.transcript}</details>
                  )}

                  {m.body && <span className="wa-text">{m.body}</span>}
                  <span className="wa-meta">
                    {hhmm(m.createdAt)}
                    {mine && <span className={`wa-ticks${m.id.startsWith('tmp-') ? '' : ' read'}`}>✓✓</span>}
                  </span>
                  {reaction && <span className="wa-reaction">{reaction}</span>}
                </div>
              </div>
            );
          })}
          {typing && (
            <div className="wa-row in">
              {typing === 'recording'
                ? <div className="wa-bubble in wa-recording">🎙️ gravando…</div>
                : <div className="wa-bubble in wa-typing"><i /><i /><i /></div>}
            </div>
          )}
          <div ref={endRef} />
        </div>

        <input ref={fileRef} type="file" hidden accept={ACCEPT} onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />

        {picked && (
          <FilePreview
            file={picked}
            onCancel={() => setPicked(null)}
            onSend={(caption) => {
              const f = picked;
              setPicked(null);
              if (f.type.startsWith('audio/')) onSendAudio(f);
              else onSendFile(f, caption);
            }}
          />
        )}

        {(mic.error || fileError) && (
          <div className="wa-mic-error" onClick={() => { mic.clearError(); setFileError(null); }}>{mic.error ?? fileError}</div>
        )}

        {startButton ? (
          <div className="wa-input wa-start">
            <button type="button" className="wa-start-btn" onClick={startButton.onClick} disabled={startButton.disabled}>
              {startButton.label}
            </button>
          </div>
        ) : mic.recording ? (
          <div className="wa-input wa-recbar">
            <button type="button" className="wa-rec-trash" onClick={() => mic.stop(false)} aria-label="Descartar"><Trash2 size={19} /></button>
            <div className="wa-rec-info"><span className="wa-rec-dot" /> {mmss(mic.seconds)}</div>
            <button type="button" className="wa-send" onClick={() => mic.stop(true)} aria-label="Enviar áudio"><Send size={19} /></button>
          </div>
        ) : (
          <form className="wa-input" onSubmit={submit}>
            <div className="wa-field">
              <span className="wa-emoji">🙂</span>
              <textarea
                ref={inputRef}
                rows={1}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKey}
                placeholder={closed ? 'Conversa encerrada. Reinicie.' : 'Mensagem'}
              />
              <button type="button" className="wa-clip" onClick={() => fileRef.current?.click()} aria-label="Anexar" title="Anexar foto, PDF ou áudio">
                <Paperclip size={19} />
              </button>
            </div>
            {text.trim() ? (
              <button className="wa-send" aria-label="Enviar">
                <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M2 21l21-9L2 3v7l15 2-15 2z" /></svg>
              </button>
            ) : (
              <button type="button" className="wa-send" onClick={mic.start} aria-label="Gravar áudio" title="Gravar áudio">
                <Mic size={20} />
              </button>
            )}
          </form>
        )}
        <div className="phone-homebar" />
      </div>
    </div>
  );
}
