import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import type { Guardrails } from './api';

export const emptyGuardrails = (): Guardrails => ({
  rules: [],
  video_reply: 'No momento não consigo assistir vídeos por aqui 🙏🏼 Se puder, me manda por texto, áudio ou foto/print que eu te ajudo.',
  audio_fail_reply: 'Não consegui entender seu áudio 🙏🏼 Pode me mandar de novo ou escrever, por favor?',
  file_fail_reply: 'Não consegui abrir esse arquivo por aqui 🙏🏼 Pode me mandar de novo, de preferência como foto ou print?',
  file_fail_action: 'reply',
});

const move = <T,>(arr: T[], i: number, d: -1 | 1): T[] => {
  const j = i + d;
  if (j < 0 || j >= arr.length) return arr;
  const out = [...arr];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
};

/** Conduta e limites: regras negativas + bloqueios de mídia com mensagem fixa. */
export default function GuardrailsEditor({ value, onChange }: { value: Guardrails; onChange: (g: Guardrails) => void }) {
  const set = (patch: Partial<Guardrails>) => onChange({ ...value, ...patch });
  const setRule = (i: number, text: string) => set({ rules: value.rules.map((r, j) => (j === i ? text : r)) });

  return (
    <>
      <h2>Conduta e limites</h2>
      <p className="muted">
        O que a IA nunca faz e como reage quando a lead sai do roteiro. Ela pode responder dúvidas rápidas e acolher, mas toda resposta
        termina trazendo a lead de volta ao próximo passo do funil. Estas regras valem acima de qualquer pedido da lead.
      </p>

      <div className="f">
        <span>Regras de conduta (uma por item)</span>
        <div className="rules-list">
          {value.rules.map((r, i) => (
            <div key={i} className="rule-item">
              <span className="rule-n">{i + 1}</span>
              <textarea rows={2} value={r} onChange={(e) => setRule(i, e.target.value)} placeholder="Ex: Assunto fora do escopo: responda em 1 frase e volte à pergunta pendente." />
              <div className="item-tools">
                <button type="button" title="Subir" onClick={() => set({ rules: move(value.rules, i, -1) })} disabled={i === 0}><ArrowUp size={14} /></button>
                <button type="button" title="Descer" onClick={() => set({ rules: move(value.rules, i, 1) })} disabled={i === value.rules.length - 1}><ArrowDown size={14} /></button>
                <button type="button" className="danger" title="Remover" onClick={() => set({ rules: value.rules.filter((_, j) => j !== i) })}><Trash2 size={14} /></button>
              </div>
            </div>
          ))}
        </div>
        <button type="button" className="btn add small" onClick={() => set({ rules: [...value.rules, ''] })}><Plus size={14} /> Adicionar regra</button>
      </div>

      <h2>Bloqueios de mídia</h2>
      <p className="muted">Mensagem fixa enviada na hora; depois a IA retoma o roteiro sozinha (responde o que mais a lead tiver dito e volta à pergunta pendente).</p>

      <label className="f">
        <span>Quando a lead manda vídeo</span>
        <textarea rows={2} value={value.video_reply ?? ''} onChange={(e) => set({ video_reply: e.target.value || null })} />
        <small>Vazio = a IA responde com as próprias palavras que não consegue assistir.</small>
      </label>

      <label className="f">
        <span>Quando o áudio não dá pra entender (falha na transcrição)</span>
        <textarea rows={2} value={value.audio_fail_reply ?? ''} onChange={(e) => set({ audio_fail_reply: e.target.value || null })} />
        <small>Vazio = passa a conversa para a equipe. Áudio transcrito mas sem sentido é tratado pela regra de conduta de "mensagem sem sentido".</small>
      </label>

      <div className="f">
        <span>Quando a foto/PDF não dá pra ler</span>
        <div className="seg seg-2">
          <button type="button" className={value.file_fail_action !== 'handoff' ? 'on' : ''} onClick={() => set({ file_fail_action: 'reply' })}>Avisar e pedir de novo</button>
          <button type="button" className={value.file_fail_action === 'handoff' ? 'on' : ''} onClick={() => set({ file_fail_action: 'handoff' })}>Passar para a equipe</button>
        </div>
        {value.file_fail_action !== 'handoff' && (
          <textarea rows={2} value={value.file_fail_reply ?? ''} onChange={(e) => set({ file_fail_reply: e.target.value || null })} />
        )}
        <small>Foto legível mas borrada é diferente: a IA já pede para reenviar com mais nitidez.</small>
      </div>
    </>
  );
}
