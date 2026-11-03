import { useRef, useState } from 'react';
import { FileAudio, FileVideo, MessageSquareText, PauseCircle, PlayCircle, Upload, Users, X, Zap } from 'lucide-react';
import {
  api, kitFileUrl, type Reception, type ReceptionKind, type ReceptionMessage, type ReceptionScenario,
} from './api';

type Case = 'volume' | 'form';
type SlotKind = ReceptionKind | 'off';

const CASES: Record<Case, { label: string; icon: typeof Zap; hint: string; slots: [string, string]; afterHint: Record<ReceptionScenario['after'], string> }> = {
  form: {
    label: 'Lead de formulário',
    icon: Zap,
    hint: 'Mais comum. Já chega com o roteiro praticamente preenchido (Meta/LP): apresenta a empresa e segue para confirmar os dados e pedir os documentos.',
    slots: ['1ª mensagem: apresentação', '2ª mensagem: transição para os documentos'],
    afterHint: {
      continue: 'A IA segue na hora: confirma os dados do formulário e pede o primeiro documento.',
      wait: 'A IA só continua quando o lead responder.',
    },
  },
  volume: {
    label: 'Lead de volume',
    icon: Users,
    hint: 'Chega sem dados: apresenta a empresa e avisa que vai fazer algumas perguntas (pré-qualificação completa).',
    slots: ['1ª mensagem: apresentação', '2ª mensagem: "vou te fazer algumas perguntas"'],
    afterHint: {
      wait: 'A IA espera o lead responder antes da primeira pergunta.',
      continue: 'A IA já manda a primeira pergunta do roteiro em seguida.',
    },
  },
};

const KIND_OPTS: { kind: SlotKind; label: string; icon: typeof Zap }[] = [
  { kind: 'text', label: 'Texto', icon: MessageSquareText },
  { kind: 'audio', label: 'Áudio', icon: FileAudio },
  { kind: 'video', label: 'Vídeo', icon: FileVideo },
  { kind: 'off', label: 'Desligada', icon: PauseCircle },
];

export const emptyReception = (): Reception => ({
  append_state_presence: true,
  volume: { after: 'wait', messages: [] },
  form: { after: 'continue', messages: [] },
});

export function Slot({ title, msg, onChange }: { title: string; msg: ReceptionMessage | null; onChange: (m: ReceptionMessage) => void }) {
  const kind: SlotKind = !msg || msg.enabled === false ? 'off' : msg.kind;
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // desligar/alternar guarda o que já tinha (texto/arquivo/transcrição)
  const setKind = (k: SlotKind) =>
    onChange(k === 'off'
      ? { ...(msg ?? { kind: 'text' }), enabled: false }
      : { ...(msg ?? {}), kind: k, enabled: true } as ReceptionMessage);

  const upload = async (file: File) => {
    setErr(null);
    const want = kind === 'audio' ? 'audio/' : 'video/';
    if (!file.type.startsWith(want)) return setErr(`Escolha um arquivo de ${kind === 'audio' ? 'áudio' : 'vídeo'}.`);
    setUploading(true);
    try {
      const r = await api.uploadMedia(file);
      onChange({ ...(msg as ReceptionMessage), kind: kind as ReceptionKind, enabled: true, media: { path: r.path, mime: r.mime, file_name: r.file_name } });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const mediaOk = msg?.media?.path && (kind === 'audio' ? msg.media.mime?.startsWith('audio') ?? true : msg.media.mime?.startsWith('video') ?? true);

  return (
    <div className={`item rx-slot${kind === 'off' ? ' off' : ''}`}>
      <div className="item-head"><strong>{title}</strong></div>
      <div className="seg seg-4">
        {KIND_OPTS.map(({ kind: k, label, icon: Icon }) => (
          <button key={k} type="button" className={kind === k ? 'on' : ''} onClick={() => setKind(k)}><Icon size={15} /> {label}</button>
        ))}
      </div>

      {kind === 'text' && (
        <label className="f rx-body">
          <span>Texto</span>
          <textarea rows={3} value={msg?.text ?? ''} onChange={(e) => onChange({ ...msg!, text: e.target.value })} />
        </label>
      )}

      {(kind === 'audio' || kind === 'video') && (
        <div className="rx-body">
          <input
            ref={fileRef}
            type="file"
            hidden
            accept={kind === 'audio' ? 'audio/*' : 'video/*'}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }}
          />
          {mediaOk ? (
            <div className="rx-media">
              {kind === 'audio'
                ? <audio controls src={kitFileUrl(msg!.media!.path)} />
                : <video controls src={kitFileUrl(msg!.media!.path)} />}
              <div className="rx-media-meta">
                <span title={msg!.media!.path}>{msg!.media!.file_name ?? msg!.media!.path}</span>
                <button type="button" className="btn small" onClick={() => fileRef.current?.click()} disabled={uploading}><Upload size={14} /> Trocar</button>
                <button type="button" className="btn small danger" onClick={() => onChange({ ...msg!, media: null })}><X size={14} /> Remover</button>
              </div>
            </div>
          ) : (
            <button type="button" className="rx-drop" onClick={() => fileRef.current?.click()} disabled={uploading}>
              {uploading ? 'Enviando…' : <><Upload size={18} /> Enviar {kind === 'audio' ? 'áudio (.ogg, .mp3, .m4a…)' : 'vídeo (.mp4…)'}</>}
            </button>
          )}
          {err && <div className="err">{err}</div>}
          {kind === 'video' && (
            <label className="f">
              <span>Legenda do vídeo (opcional)</span>
              <input value={msg?.caption ?? ''} onChange={(e) => onChange({ ...msg!, caption: e.target.value || null })} />
            </label>
          )}
          <label className="f">
            <span>O que {kind === 'audio' ? 'o áudio' : 'o vídeo'} diz</span>
            <textarea
              rows={3}
              value={msg?.transcript ?? ''}
              onChange={(e) => onChange({ ...msg!, transcript: e.target.value || null })}
              placeholder="Ex: Oi, tudo bem? Aqui é a Bella, do escritório..."
            />
            <small>A IA não escuta o arquivo. Ela usa este texto para saber o que já foi dito e não se apresentar de novo.</small>
          </label>
          {!msg?.media?.path && <small className="warn-inline">Sem arquivo, esta mensagem não é enviada.</small>}
        </div>
      )}

      {kind === 'off' && <p className="muted rx-off">Não envia nada nesta posição.</p>}
    </div>
  );
}

export default function ReceptionEditor({ value, onChange }: { value: Reception; onChange: (r: Reception) => void }) {
  const [tab, setTab] = useState<Case>('form');
  const c = CASES[tab];
  const sc = value[tab];
  // posições fixas: 1ª e 2ª (desligada fica salva com enabled=false, não "pula" de lugar)
  const slots: (ReceptionMessage | null)[] = [sc.messages[0] ?? null, sc.messages[1] ?? null];

  const setScenario = (patch: Partial<ReceptionScenario>) => onChange({ ...value, [tab]: { ...sc, ...patch } });
  const setSlot = (i: number, m: ReceptionMessage) => {
    const next = [...slots];
    next[i] = m;
    setScenario({ messages: next.map((x) => x ?? { kind: 'text', text: '', enabled: false }) });
  };

  return (
    <>
      <h2>Recepção</h2>
      <p className="muted">As primeiras mensagens, fixas (a IA não gera). Cada uma pode ser texto ou um áudio/vídeo gravado pela equipe.</p>

      <div className="tabs">
        {(Object.keys(CASES) as Case[]).map((k) => {
          const Icon = CASES[k].icon;
          return (
            <button key={k} type="button" className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
              <Icon size={16} /> {CASES[k].label}
              <span className="tab-count">{value[k].messages.filter((m) => m.enabled !== false).map((m) => (m.kind === 'text' ? 'Texto' : m.kind === 'audio' ? 'Áudio' : 'Vídeo')).join(' + ') || 'nenhuma'}</span>
            </button>
          );
        })}
      </div>
      <p className="tab-hint">{c.hint}</p>

      {/* key força remontar ao trocar de aba (estado de upload por slot) */}
      <div key={tab}>
        <Slot title={c.slots[0]} msg={slots[0]} onChange={(m) => setSlot(0, m)} />
        <Slot title={c.slots[1]} msg={slots[1]} onChange={(m) => setSlot(1, m)} />
      </div>

      <div className="f">
        <span>Depois da recepção</span>
        <div className="seg seg-2">
          <button type="button" className={sc.after === 'continue' ? 'on' : ''} onClick={() => setScenario({ after: 'continue' })}><PlayCircle size={15} /> IA continua na hora</button>
          <button type="button" className={sc.after === 'wait' ? 'on' : ''} onClick={() => setScenario({ after: 'wait' })}><PauseCircle size={15} /> Espera o lead responder</button>
        </div>
        <small>{c.afterHint[sc.after]}</small>
      </div>

      <label className="f f-check rx-presence">
        <input
          type="checkbox"
          checked={value.append_state_presence !== false}
          onChange={(e) => onChange({ ...value, append_state_presence: e.target.checked })}
        />
        Na 1ª mensagem de texto, acrescentar "Atendemos em todo o Brasil, com forte presença em &lt;estado do DDD&gt;" (vale para os dois cenários)
      </label>
    </>
  );
}
