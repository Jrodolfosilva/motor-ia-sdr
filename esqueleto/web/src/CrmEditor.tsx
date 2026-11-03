import { Plus, Trash2 } from 'lucide-react';
import type { ClassificationLabel, CrmAction, CrmConfig, CrmEventDef } from './api';

export const emptyCrm = (): CrmConfig => ({ stages: [], labels: [], actions: {} });

const slug = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'item';

const uniqueId = (base: string, taken: string[]) => {
  let id = slug(base);
  let n = 2;
  while (taken.includes(id)) id = `${slug(base)}_${n++}`;
  return id;
};

/** Etiqueta: clique alterna entre "não mexe" → "adiciona" → "remove". */
function LabelToggle({ name, color, state, onClick }: { name: string; color?: string | null; state: 'add' | 'remove' | null; onClick: () => void }) {
  return (
    <button type="button" className={`crm-tag${state ? ` ${state}` : ''}`} onClick={onClick} title="Clique: adiciona → remove → não mexe">
      <span className="crm-dot" style={{ background: color ?? '#9ca3af' }} />
      {state === 'add' ? '+ ' : state === 'remove' ? '− ' : ''}{name}
    </button>
  );
}

export default function CrmEditor({ value, events, classifications, onChange }: {
  value: CrmConfig; events: CrmEventDef[]; classifications: ClassificationLabel[]; onChange: (c: CrmConfig) => void;
}) {
  const set = (patch: Partial<CrmConfig>) => onChange({ ...value, ...patch });
  const setAction = (key: string, patch: Partial<CrmAction>) => {
    const cur = value.actions[key] ?? {};
    set({ actions: { ...value.actions, [key]: { ...cur, ...patch } } });
  };
  const cycleLabel = (key: string, labelId: string) => {
    const a = value.actions[key] ?? {};
    const add = a.add_labels ?? [];
    const rem = a.remove_labels ?? [];
    if (add.includes(labelId)) setAction(key, { add_labels: add.filter((x) => x !== labelId), remove_labels: [...rem, labelId] });
    else if (rem.includes(labelId)) setAction(key, { remove_labels: rem.filter((x) => x !== labelId) });
    else setAction(key, { add_labels: [...add, labelId] });
  };

  const rows: { key: string; group: string; label: string; description: string; later?: boolean }[] = [
    ...events.filter((e) => e.stage !== '6. Encerramento' && e.stage !== 'Follow-up').map((e) => ({ key: e.key, group: e.stage, label: e.label, description: e.description, later: e.later })),
    ...classifications.map((c) => ({
      key: `classificado:${c.key}`, group: '5. Classificação', label: c.label || c.key,
      description: c.outcome === 'qualify' ? 'Qualificada: passa para a equipe.' : 'Desqualificada: encerra a conversa.',
    })),
    ...events.filter((e) => e.stage === '6. Encerramento' || e.stage === 'Follow-up').map((e) => ({ key: e.key, group: e.stage, label: e.label, description: e.description, later: e.later })),
  ];

  // remove referências a etapa/etiqueta apagada
  const removeStage = (id: string) => set({
    stages: value.stages.filter((s) => s.id !== id),
    actions: Object.fromEntries(Object.entries(value.actions).map(([k, a]) => [k, a.move_to === id ? { ...a, move_to: null } : a])),
  });
  const removeLabel = (id: string) => set({
    labels: value.labels.filter((l) => l.id !== id),
    actions: Object.fromEntries(Object.entries(value.actions).map(([k, a]) => [k, {
      ...a, add_labels: a.add_labels?.filter((x) => x !== id), remove_labels: a.remove_labels?.filter((x) => x !== id),
    }])),
  });

  let lastGroup = '';
  return (
    <>
      <h2>CRM / Kanban</h2>
      <p className="muted">
        Em cada marco do atendimento, a IA move o card no kanban e mexe nas etiquetas da conversa. Cada marco dispara uma vez por conversa
        (documento: uma vez por documento). Etapas e etiquetas estão cadastradas à mão por enquanto; quando o CRM for conectado, vêm de lá.
      </p>

      <label className="f f-check rx-presence">
        <input type="checkbox" checked={value.forward_only !== false} onChange={(e) => set({ forward_only: e.target.checked })} />
        O card só anda para a frente (se um marco mandar para uma etapa anterior à atual, só as etiquetas são aplicadas). A ordem é a da lista "Etapas do kanban".
      </label>

      <h2>O que acontece em cada marco</h2>
      <div className="crm-table">
        <div className="crm-row crm-head"><span>Marco</span><span>Mover para</span><span>Etiquetas (clique: + adiciona · − remove)</span></div>
        {rows.map((r) => {
          const a = value.actions[r.key] ?? {};
          const header = r.group !== lastGroup ? <div className="crm-group" key={`g-${r.group}`}>{r.group}</div> : null;
          lastGroup = r.group;
          return [
            header,
            <div key={r.key} className={`crm-row${r.later ? ' later' : ''}`}>
              <span className="crm-event">
                <strong>{r.label}{r.later ? <em> · Fase 2</em> : null}</strong>
                <small>{r.description}</small>
              </span>
              <select value={a.move_to ?? ''} onChange={(e) => setAction(r.key, { move_to: e.target.value || null })}>
                <option value="">— não mover —</option>
                {value.stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <span className="crm-tags">
                {value.labels.map((l) => (
                  <LabelToggle
                    key={l.id}
                    name={l.name}
                    color={l.color}
                    state={a.add_labels?.includes(l.id) ? 'add' : a.remove_labels?.includes(l.id) ? 'remove' : null}
                    onClick={() => cycleLabel(r.key, l.id)}
                  />
                ))}
                {!value.labels.length && <small className="muted">Cadastre etiquetas abaixo.</small>}
              </span>
            </div>,
          ];
        })}
      </div>

      <div className="grid2 crm-catalog">
        <div>
          <h2>Etapas do kanban</h2>
          {value.stages.map((s, i) => (
            <div key={s.id} className="crm-cat-row">
              <span className="rule-n">{i + 1}</span>
              <input value={s.name} onChange={(e) => set({ stages: value.stages.map((x) => (x.id === s.id ? { ...x, name: e.target.value } : x)) })} />
              <code title="id no CRM">{s.id}</code>
              <button type="button" className="icon-btn danger" onClick={() => removeStage(s.id)} title="Remover"><Trash2 size={14} /></button>
            </div>
          ))}
          <button type="button" className="btn add small" onClick={() => set({ stages: [...value.stages, { id: uniqueId('nova etapa', value.stages.map((s) => s.id)), name: 'Nova etapa' }] })}>
            <Plus size={14} /> Etapa
          </button>
        </div>
        <div>
          <h2>Etiquetas</h2>
          {value.labels.map((l) => (
            <div key={l.id} className="crm-cat-row">
              <input type="color" value={l.color ?? '#9ca3af'} onChange={(e) => set({ labels: value.labels.map((x) => (x.id === l.id ? { ...x, color: e.target.value } : x)) })} />
              <input value={l.name} onChange={(e) => set({ labels: value.labels.map((x) => (x.id === l.id ? { ...x, name: e.target.value } : x)) })} />
              <code title="id no CRM">{l.id}</code>
              <button type="button" className="icon-btn danger" onClick={() => removeLabel(l.id)} title="Remover"><Trash2 size={14} /></button>
            </div>
          ))}
          <button type="button" className="btn add small" onClick={() => set({ labels: [...value.labels, { id: uniqueId('nova etiqueta', value.labels.map((l) => l.id)), name: 'Nova etiqueta', color: '#9ca3af' }] })}>
            <Plus size={14} /> Etiqueta
          </button>
        </div>
      </div>
    </>
  );
}
