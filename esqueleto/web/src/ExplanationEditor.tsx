import { PauseCircle, PlayCircle } from 'lucide-react';
import { Slot } from './ReceptionEditor';
import type { ExplanationModule, ReceptionMessage, RequiredField } from './api';

export const emptyExplanation = (): ExplanationModule => ({ enabled: false, messages: [], after: 'continue', trigger_fields: [] });

/** Módulo de explicação: mensagens fixas entre as perguntas e o pedido de documentos. */
export default function ExplanationEditor({ value, fields, onChange }: {
  value: ExplanationModule; fields: RequiredField[]; onChange: (v: ExplanationModule) => void;
}) {
  const set = (patch: Partial<ExplanationModule>) => onChange({ ...value, ...patch });
  const slots: (ReceptionMessage | null)[] = [value.messages[0] ?? null, value.messages[1] ?? null];
  const setSlot = (i: number, m: ReceptionMessage) => {
    const next = [...slots];
    next[i] = m;
    set({ messages: next.map((x) => x ?? { kind: 'text', text: '', enabled: false }) });
  };
  const toggleTrigger = (key: string) =>
    set({ trigger_fields: value.trigger_fields.includes(key) ? value.trigger_fields.filter((k) => k !== key) : [...value.trigger_fields, key] });

  return (
    <>
      <h2>Explicação</h2>
      <p className="muted">
        Mensagens fixas entre as perguntas e o pedido de documentos: como o benefício funciona, valor de referência e por que
        precisamos dos documentos. Saem uma única vez, quando as perguntas-gatilho estiverem respondidas. Vale para os dois tipos de lead.
      </p>

      <label className="f f-check rx-presence">
        <input type="checkbox" checked={value.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        Usar o módulo de explicação (desligado = a IA explica sozinha, com as próprias palavras)
      </label>

      {value.enabled && (
        <>
          <div className="f">
            <span>Dispara quando estas perguntas estiverem respondidas/confirmadas</span>
            <div className="chips">
              {fields.map((f) => (
                <label key={f.key} className={`chip${value.trigger_fields.includes(f.key) ? ' on' : ''}`}>
                  <input type="checkbox" checked={value.trigger_fields.includes(f.key)} onChange={() => toggleTrigger(f.key)} /> {f.key}
                </label>
              ))}
            </div>
            <small>Nenhuma marcada = espera todas as perguntas. Até disparar, a IA não fala de valores nem pede documentos.</small>
          </div>

          <Slot title="1ª mensagem" msg={slots[0]} onChange={(m) => setSlot(0, m)} />
          <Slot title="2ª mensagem" msg={slots[1]} onChange={(m) => setSlot(1, m)} />

          <div className="f">
            <span>Depois da explicação</span>
            <div className="seg seg-2">
              <button type="button" className={value.after === 'continue' ? 'on' : ''} onClick={() => set({ after: 'continue' })}><PlayCircle size={15} /> IA já pede o 1º documento</button>
              <button type="button" className={value.after === 'wait' ? 'on' : ''} onClick={() => set({ after: 'wait' })}><PauseCircle size={15} /> Espera o lead responder</button>
            </div>
            <small>
              {value.after === 'continue'
                ? 'Na mesma hora a IA pede o primeiro documento, sem repetir a explicação.'
                : 'Bom quando a 2ª mensagem termina com uma pergunta ("podemos seguir com a análise?").'}
            </small>
          </div>
        </>
      )}
    </>
  );
}
