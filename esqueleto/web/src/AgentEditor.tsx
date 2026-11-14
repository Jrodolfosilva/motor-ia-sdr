import { useEffect, useMemo, useState, type ReactNode } from 'react';
import ReceptionEditor, { emptyReception } from './ReceptionEditor';
import ExplanationEditor, { emptyExplanation } from './ExplanationEditor';
import GuardrailsEditor, { emptyGuardrails } from './GuardrailsEditor';
import CrmEditor, { emptyCrm } from './CrmEditor';
import PublicLinkCard from './PublicLinkCard';
import {
  api, type AgentConfig, type PublicLink, type Reception, type ReceptionMessage, type ClassificationLabel, type DocumentFileType, type KitFile, type RequiredDocument, type Rule, type RuleOperator,
} from './api';

type Section = 'geral' | 'conduta' | 'crm' | 'recepcao' | 'explicacao' | 'prompt' | 'mensagens' | 'perguntas' | 'documentos' | 'classificacao' | 'faq' | 'followup' | 'publico' | 'json';

/** Seções na ordem das etapas da conversa; `group` vira um subtítulo no menu. */
const SECTIONS: { id: Section; label: string; group?: string }[] = [
  { id: 'geral', label: 'Geral e modelos', group: 'Agente' },
  { id: 'prompt', label: 'System prompt' },
  { id: 'conduta', label: 'Conduta e limites' },
  { id: 'faq', label: 'FAQ' },
  { id: 'recepcao', label: '1. Recepção', group: 'Etapas da conversa' },
  { id: 'perguntas', label: '2. Perguntas' },
  { id: 'explicacao', label: '3. Explicação' },
  { id: 'documentos', label: '4. Documentos' },
  { id: 'classificacao', label: '5. Classificação' },
  { id: 'mensagens', label: '6. Encerramento' },
  { id: 'followup', label: 'Follow-up (inatividade)' },
  { id: 'crm', label: 'CRM / Kanban', group: 'Integração' },
  { id: 'publico', label: 'Link público e teste', group: 'Teste' },
  { id: 'json', label: 'JSON bruto', group: 'Avançado' },
];

const OPERATORS: { op: RuleOperator; label: string; value: 'none' | 'number' | 'list' }[] = [
  { op: 'present', label: 'está preenchido', value: 'none' },
  { op: 'contains_any', label: 'contém algum de', value: 'list' },
  { op: 'not_contains_any', label: 'não contém nenhum de', value: 'list' },
  { op: 'gte_months', label: '≥ N meses (duração)', value: 'number' },
  { op: 'lt_months', label: '< N meses (duração)', value: 'number' },
  { op: 'months_since_gte', label: 'há ≥ N meses (data)', value: 'number' },
  { op: 'months_since_lt', label: 'há < N meses (data)', value: 'number' },
];

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

/** Kit no formato antigo → recepção equivalente (para abrir no editor). */
function legacyReception(a: KitFile['agent']): Reception {
  const r = emptyReception();
  const greet: ReceptionMessage[] = a.greeting_example ? [{ kind: 'text', text: a.greeting_example }] : [];
  r.volume.messages = [...greet, ...(a.consent_message ? [{ kind: 'text' as const, text: a.consent_message }] : [])];
  r.form.messages = greet;
  return r;
}

// ---------- campos genéricos ----------

function Text({ label, value, onChange, placeholder, hint }: {
  label: string; value: string | null | undefined; onChange: (v: string) => void; placeholder?: string; hint?: string;
}) {
  return (
    <label className="f">
      <span>{label}</span>
      <input value={value ?? ''} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      {hint && <small>{hint}</small>}
    </label>
  );
}

function Area({ label, value, onChange, rows = 3, hint, mono }: {
  label: string; value: string | null | undefined; onChange: (v: string) => void; rows?: number; hint?: string; mono?: boolean;
}) {
  return (
    <label className="f">
      <span>{label}</span>
      <textarea className={mono ? 'mono' : ''} rows={rows} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
      {hint && <small>{hint}</small>}
    </label>
  );
}

/** "Pergunta: resposta" por linha. Rascunho local; só converte ao sair do campo (não come linha incompleta). */
function FormAnswers({ value, onChange }: { value: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const toText = (v: Record<string, string>) => Object.entries(v).map(([q, r]) => `${q}: ${r}`).join('\n');
  const [draft, setDraft] = useState(() => toText(value));
  const commit = () => {
    const out: Record<string, string> = {};
    for (const line of draft.split('\n')) {
      const i = line.indexOf(':');
      if (i > 0 && line.slice(0, i).trim()) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    onChange(out);
    setDraft(toText(out));
  };
  return (
    <label className="f">
      <span>Respostas do formulário de exemplo (pergunta: resposta, uma por linha)</span>
      <textarea rows={4} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} placeholder="Qual o seu interesse?: Quero um orçamento" />
      <small>No link público, o lead "Veio do formulário" chega com estas respostas (mais o nome digitado).</small>
    </label>
  );
}

function Num({ label, value, onChange, hint }: {
  label: string; value: number | null | undefined; onChange: (v: number | null) => void; hint?: string;
}) {
  return (
    <label className="f f-num">
      <span>{label}</span>
      <input type="number" value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} />
      {hint && <small>{hint}</small>}
    </label>
  );
}

function Card({ title, onRemove, onUp, onDown, children }: {
  title: ReactNode; onRemove: () => void; onUp?: () => void; onDown?: () => void; children: ReactNode;
}) {
  return (
    <div className="item">
      <div className="item-head">
        <strong>{title}</strong>
        <div className="item-tools">
          {onUp && <button type="button" title="Subir" onClick={onUp}>↑</button>}
          {onDown && <button type="button" title="Descer" onClick={onDown}>↓</button>}
          <button type="button" className="danger" title="Remover" onClick={onRemove}>✕</button>
        </div>
      </div>
      {children}
    </div>
  );
}

function move<T>(arr: T[], i: number, d: -1 | 1): T[] {
  const j = i + d;
  if (j < 0 || j >= arr.length) return arr;
  const out = [...arr];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

// ---------- editor de regra ----------

function RuleRow({ rule, fields, onChange, onRemove }: {
  rule: Rule; fields: string[]; onChange: (r: Rule) => void; onRemove: () => void;
}) {
  const meta = OPERATORS.find((o) => o.op === rule.operator) ?? OPERATORS[0];
  const listValue = Array.isArray(rule.value) ? (rule.value as string[]).join(', ') : '';
  return (
    <div className="rule">
      <select value={rule.field} onChange={(e) => onChange({ ...rule, field: e.target.value })}>
        {!fields.includes(rule.field) && <option value={rule.field}>{rule.field || '(campo)'}</option>}
        {fields.map((f) => <option key={f} value={f}>{f}</option>)}
      </select>
      <select
        value={rule.operator}
        onChange={(e) => {
          const op = e.target.value as RuleOperator;
          const kind = OPERATORS.find((o) => o.op === op)!.value;
          const value = kind === 'none' ? undefined : kind === 'number' ? (typeof rule.value === 'number' ? rule.value : 0) : (Array.isArray(rule.value) ? rule.value : []);
          onChange({ field: rule.field, operator: op, ...(value === undefined ? {} : { value }) });
        }}
      >
        {OPERATORS.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
      </select>
      {meta.value === 'number' && (
        <input type="number" value={typeof rule.value === 'number' ? rule.value : ''} onChange={(e) => onChange({ ...rule, value: Number(e.target.value) })} />
      )}
      {meta.value === 'list' && (
        <input
          placeholder="termo1, termo2"
          defaultValue={listValue}
          onBlur={(e) => onChange({ ...rule, value: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
        />
      )}
      <button type="button" className="danger" onClick={onRemove}>✕</button>
    </div>
  );
}

// ---------- tela ----------

export default function AgentEditor({ agentKey, onSaved }: { agentKey: string; onSaved?: () => void }) {
  const [loaded, setLoaded] = useState<AgentConfig | null>(null);
  const [link, setLink] = useState<PublicLink>({ enabled: false, token: null });
  const [kit, setKit] = useState<KitFile | null>(null);
  const [prompt, setPrompt] = useState('');
  const [section, setSection] = useState<Section>('geral');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [jsonDraft, setJsonDraft] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);

  const load = (cfg: AgentConfig) => {
    setLoaded(cfg);
    setLink(cfg.publicLink);
    setKit(clone(cfg.kit));
    setPrompt(cfg.system_prompt);
  };

  useEffect(() => {
    api.getAgent(agentKey).then(load).catch((e) => setMsg({ ok: false, text: String(e.message ?? e) }));
  }, [agentKey]);

  useEffect(() => {
    if (section === 'json' && kit) {
      setJsonDraft(JSON.stringify(kit, null, 2));
      setJsonError(null);
    }
  }, [section]);

  const dirty = useMemo(
    () => !!loaded && !!kit && (JSON.stringify(loaded.kit) !== JSON.stringify(kit) || loaded.system_prompt !== prompt),
    [loaded, kit, prompt],
  );

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty) e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  if (!kit || !loaded) {
    return <div className="editor-loading">{msg ? `Erro: ${msg.text}` : 'Carregando agente…'}</div>;
  }

  const a = kit.agent;
  const k = kit.kit;
  const setAgent = (patch: Partial<KitFile['agent']>) => setKit({ ...kit, agent: { ...a, ...patch } });
  const setKitInfo = (patch: Partial<KitFile['kit']>) => setKit({ ...kit, kit: { ...k, ...patch } });
  const fieldKeys = a.required_fields.map((f) => f.key).filter(Boolean);
  const docs = a.required_documents ?? [];

  const save = async () => {
    let toSave = kit;
    if (section === 'json') {
      try {
        toSave = JSON.parse(jsonDraft);
      } catch (e) {
        setJsonError((e as Error).message);
        return;
      }
    }
    setSaving(true);
    setMsg(null);
    try {
      const cfg = await api.saveAgent(agentKey, toSave, prompt);
      load(cfg);
      onSaved?.();
      if (section === 'json') setJsonDraft(JSON.stringify(cfg.kit, null, 2));
      setMsg({ ok: true, text: 'Salvo. Vale para as próximas mensagens do simulador e do link público.' });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    load(loaded);
    if (section === 'json') setJsonDraft(JSON.stringify(loaded.kit, null, 2));
    setMsg(null);
  };

  const setLabel = (i: number, patch: Partial<ClassificationLabel>) => {
    const labels = [...a.classification_labels];
    labels[i] = { ...labels[i], ...patch };
    setAgent({ classification_labels: labels });
  };

  return (
    <div className="editor">
      <aside className="card editor-nav">
        <div className="editor-title">
          <strong>{a.name || k.name}</strong>
          <small title={loaded.kitPath}>{loaded.kitPath.split(/[\\/]/).slice(-2).join('/')}</small>
        </div>
        {SECTIONS.map((s) => (
          <div key={s.id} className="nav-entry">
            {s.group && <div className="nav-group">{s.group}</div>}
            <button className={section === s.id ? 'on' : ''} onClick={() => setSection(s.id)}>{s.label}</button>
          </div>
        ))}
        {!loaded.hasApiKey && <div className="warn">TOGETHER_API_KEY não definida no backend. O simulador não vai conseguir chamar o LLM.</div>}
      </aside>

      <section className="card editor-main">
        <div className="editor-bar">
          <span>{dirty ? '● Alterações não salvas' : 'Tudo salvo'}</span>
          {msg && <span className={msg.ok ? 'ok' : 'err'}>{msg.text}</span>}
          <div className="spacer" />
          <button className="btn" disabled={!dirty || saving} onClick={discard}>Descartar</button>
          <button className="btn primary" disabled={(!dirty && section !== 'json') || saving} onClick={save}>{saving ? 'Salvando…' : 'Salvar'}</button>
        </div>

        <div className="editor-body">
          {section === 'geral' && (
            <>
              <h2>Geral</h2>
              <div className="grid2">
                <Text label="Nome do agente" value={a.name} onChange={(v) => setAgent({ name: v })} />
                <Text label="Nome do kit" value={k.name} onChange={(v) => setKitInfo({ name: v })} />
                <Text label="Segmento" value={k.category} placeholder="Ex: previdenciário, odontologia, imobiliária" onChange={(v) => setKitInfo({ category: v || undefined })} />
              </div>
              <label className="f-check">
                <input type="checkbox" checked={!!kit.template} onChange={(e) => setKit({ ...kit, template: e.target.checked })} />
                Template: aparece primeiro como base ao criar agentes novos (dá para copiar só algumas partes do fluxo)
              </label>
              <Area label="Informações da empresa (company_info)" rows={10} value={k.company_info} onChange={(v) => setKitInfo({ company_info: v })} hint="Vai no prompt do responder. Honorários, prazos, prova social etc." />
              <h2>Modelos</h2>
              <div className="grid2">
                <label className="f">
                  <span>Provider</span>
                  <select value={a.provider} onChange={(e) => setAgent({ provider: e.target.value })}>
                    {['together', 'openai', 'anthropic', 'deepseek'].map((p) => <option key={p}>{p}</option>)}
                  </select>
                  <small>O simulador hoje só implementa Together (openaiCompatible).</small>
                </label>
                <Text label="Modelo padrão (fallback)" value={a.model} onChange={(v) => setAgent({ model: v || undefined })} />
                {(['responder', 'extractor', 'qualifier', 'vision'] as const).map((role) => (
                  <Text key={role} label={`Modelo: ${role}`} value={a.models?.[role]} onChange={(v) => setAgent({ models: { ...a.models, [role]: v } })} />
                ))}
              </div>
              <h2>Limites</h2>
              <div className="grid3">
                <Num label="Máx. turnos" value={a.max_turns} onChange={(v) => setAgent({ max_turns: v ?? 20 })} hint="Passou disso → handoff" />
                <Num label="Debounce (s)" value={a.debounce_seconds} onChange={(v) => setAgent({ debounce_seconds: v ?? 8 })} hint="Simulador usa 1,5s fixo" />
              </div>
              <h2>Ritmo das mensagens</h2>
              <p className="muted">A IA quebra a resposta em até 3 balões. Antes de cada um aparece "digitando…" por um tempo proporcional ao texto. Se o lead escrever no meio, os balões restantes são descartados e a IA responde de novo.</p>
              {(() => {
                const bd = a.bubble_delay ?? { min_seconds: 2, max_seconds: 6, chars_per_second: 20 };
                const set = (patch: Partial<typeof bd>) => setAgent({ bubble_delay: { ...bd, ...patch } });
                return (
                  <div className="grid3">
                    <Num label="Pausa mínima (s)" value={bd.min_seconds} onChange={(v) => set({ min_seconds: v ?? 0 })} />
                    <Num label="Pausa máxima (s)" value={bd.max_seconds} onChange={(v) => set({ max_seconds: v ?? 0 })} />
                    <Num label="Velocidade (caracteres/s)" value={bd.chars_per_second} onChange={(v) => set({ chars_per_second: v ?? 20 })} hint="Maior = digita mais rápido" />
                  </div>
                );
              })()}
              <Area
                label="Palavras-chave de handoff (uma por linha)"
                rows={6}
                value={a.handoff_keywords.join('\n')}
                onChange={(v) => setAgent({ handoff_keywords: v.split('\n').map((s) => s.trim()).filter(Boolean) })}
                hint="Se o lead escrever qualquer uma, passa direto para humano."
              />
            </>
          )}

          {section === 'publico' && (
            <>
              <h2>Link público</h2>
              <PublicLinkCard agentKey={agentKey} link={link} onChange={setLink} />
              <h2>Lead de teste</h2>
              <p className="muted">O que o simulador e a página do link público usam para começar uma conversa de teste.</p>
              <Text
                label="Primeira mensagem do lead frio"
                value={a.test_lead?.cold_message}
                placeholder="Olá, gostaria de mais informações"
                onChange={(v) => setAgent({ test_lead: { ...a.test_lead, cold_message: v } })}
                hint="Já vem escrita no celular quando o lead chega sem dados."
              />
              <FormAnswers
                value={a.test_lead?.form_answers ?? {}}
                onChange={(form_answers) => setAgent({ test_lead: { ...a.test_lead, form_answers } })}
              />
            </>
          )}

          {section === 'prompt' && (
            <>
              <h2>System prompt do responder</h2>
              <p className="muted">
                Salvo no MongoDB, junto com o kit (coleção <code>kits</code>).
              </p>
              <textarea className="mono prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} spellCheck={false} />
            </>
          )}

          {section === 'recepcao' && (
            <ReceptionEditor
              value={a.reception ?? legacyReception(a)}
              onChange={(reception) => {
                // ao editar, migra do formato antigo (greeting_example/consent_message) para reception
                const { greeting_example: _g, consent_message: _c, ...rest } = a;
                setKit({ ...kit, agent: { ...rest, reception } });
              }}
            />
          )}

          {section === 'crm' && (
            <CrmEditor
              value={a.crm ?? emptyCrm()}
              events={loaded.crmEvents ?? []}
              classifications={a.classification_labels}
              onChange={(crm) => setAgent({ crm })}
            />
          )}

          {section === 'conduta' && (
            <GuardrailsEditor value={a.guardrails ?? emptyGuardrails()} onChange={(guardrails) => setAgent({ guardrails })} />
          )}

          {section === 'explicacao' && (
            <ExplanationEditor
              value={a.explanation ?? emptyExplanation()}
              fields={a.required_fields}
              onChange={(explanation) => setAgent({ explanation })}
            />
          )}

          {section === 'mensagens' && (
            <>
              <h2>Encerramento</h2>
              <p className="muted">Mensagens fixas de saída. A saudação e o "vou te fazer perguntas" agora ficam em <strong>1. Recepção</strong>.</p>
              <Area label="Mensagem de handoff" value={a.handoff_message} onChange={(v) => setAgent({ handoff_message: v })} hint="Use {atendente} para o nome do humano." />
              <Area label="Mensagem de desqualificação (padrão)" value={a.disqualify_message} onChange={(v) => setAgent({ disqualify_message: v || null })} hint="Cada rótulo de classificação pode sobrescrever." />
              <Area label="Mensagem de fallback (erro)" value={a.fallback_message} onChange={(v) => setAgent({ fallback_message: v })} />
            </>
          )}

          {section === 'perguntas' && (
            <>
              <h2>Roteiro: perguntas</h2>
              <p className="muted">
                Dados que o lead informa por texto. Lead frio: a IA pergunta um por vez. Lead de formulário: o que já veio do form a IA só confirma.
                Classificação só roda com todas respondidas/confirmadas e todos os documentos recebidos. A ordem é a ordem das perguntas.
              </p>
              {a.required_fields.map((f, i) => (
                <Card
                  key={i}
                  title={<>{i + 1}. <code>{f.key || 'novo_campo'}</code></>}
                  onRemove={() => setAgent({ required_fields: a.required_fields.filter((_, j) => j !== i) })}
                  onUp={i > 0 ? () => setAgent({ required_fields: move(a.required_fields, i, -1) }) : undefined}
                  onDown={i < a.required_fields.length - 1 ? () => setAgent({ required_fields: move(a.required_fields, i, 1) }) : undefined}
                >
                  {(() => {
                    const upd = (patch: Partial<typeof f>) => {
                      const list = [...a.required_fields];
                      list[i] = { ...f, ...patch };
                      setAgent({ required_fields: list });
                    };
                    return (
                      <>
                        <Text label="Chave" value={f.key} onChange={(v) => upd({ key: v.replace(/\s+/g, '_') })} hint="Nome interno, usado nas regras." />
                        <Area label="Descrição para o extractor" rows={2} value={f.label} onChange={(v) => upd({ label: v })} />
                        <Area label="Pergunta (lead frio)" rows={2} value={f.question} onChange={(v) => upd({ question: v })} />
                        <Area
                          label="Confirmação (lead de formulário)"
                          rows={2}
                          value={f.confirm_question}
                          onChange={(v) => upd({ confirm_question: v || null })}
                          hint="Opcional. Use {valor} para o que veio do form. Ex: A previsão do parto é pra {valor}, confere?"
                        />
                        <div className="f">
                          <span>Se a resposta não vier certa</span>
                          <small className="muted">Não sabe, não lembra, resposta vaga ou estranha, recusa: a IA explica por que precisa, orienta como descobrir e pergunta de novo.</small>
                        </div>
                        <Area
                          label="Por que precisamos"
                          rows={2}
                          value={f.why}
                          onChange={(v) => upd({ why: v || null })}
                          hint="Ex: o direito tem prazo contado da saída do último emprego, então essa data decide se ainda dá tempo."
                        />
                        <Area
                          label="Como ela consegue responder"
                          rows={3}
                          value={f.help}
                          onChange={(v) => upd({ help: v || null })}
                          hint="Onde olhar e o que serve como aproximação. Ex: mês e ano já servem; está no app Carteira de Trabalho Digital, em Contratos."
                        />
                        <Num
                          label="Quantas vezes insistir"
                          value={f.insist}
                          onChange={(v) => upd({ insist: v })}
                          hint="Depois disso a IA segue e o item vai como pendência para a equipe. Vazio = 2."
                        />
                      </>
                    );
                  })()}
                </Card>
              ))}
              <button className="btn add" onClick={() => setAgent({ required_fields: [...a.required_fields, { key: '', label: '', question: '' }] })}>+ Adicionar pergunta</button>
            </>
          )}

          {section === 'documentos' && (
            <>
              <h2>Roteiro: documentos</h2>
              <p className="muted">
                Arquivos que o lead envia para comprovar os dados. Cada documento diz o tipo aceito, o que serve, onde conseguir e quais perguntas ele comprova
                (documento recebido dispensa confirmar a pergunta por texto).
              </p>
              {docs.map((d, i) => {
                const upd = (patch: Partial<RequiredDocument>) => {
                  const list = [...docs];
                  list[i] = { ...d, ...patch };
                  setAgent({ required_documents: list });
                };
                const toggleType = (t: DocumentFileType) =>
                  upd({ file_types: d.file_types.includes(t) ? d.file_types.filter((x) => x !== t) : [...d.file_types, t] });
                const toggleValidates = (key: string) => {
                  const cur = d.validates ?? [];
                  upd({ validates: cur.includes(key) ? cur.filter((x) => x !== key) : [...cur, key] });
                };
                return (
                  <Card
                    key={i}
                    title={<>{i + 1}. {d.label || 'Novo documento'} <code>{d.key || 'chave'}</code></>}
                    onRemove={() => setAgent({ required_documents: docs.filter((_, j) => j !== i) })}
                    onUp={i > 0 ? () => setAgent({ required_documents: move(docs, i, -1) }) : undefined}
                    onDown={i < docs.length - 1 ? () => setAgent({ required_documents: move(docs, i, 1) }) : undefined}
                  >
                    <div className="grid2">
                      <Text label="Chave" value={d.key} onChange={(v) => upd({ key: v.replace(/\s+/g, '_') })} />
                      <Text label="Nome do documento" value={d.label} onChange={(v) => upd({ label: v })} />
                    </div>
                    <div className="f">
                      <span>Tipo de arquivo aceito</span>
                      <div className="chips">
                        <label className={`chip${d.file_types.includes('image') ? ' on' : ''}`}><input type="checkbox" checked={d.file_types.includes('image')} onChange={() => toggleType('image')} /> Foto / print</label>
                        <label className={`chip${d.file_types.includes('pdf') ? ' on' : ''}`}><input type="checkbox" checked={d.file_types.includes('pdf')} onChange={() => toggleType('pdf')} /> PDF</label>
                      </div>
                    </div>
                    <Area
                      label="O que serve (um por linha)"
                      rows={3}
                      value={d.accepted.join('\n')}
                      onChange={(v) => upd({ accepted: v.split('\n').map((s) => s.trim()).filter(Boolean) })}
                      hint="Variações aceitas. Ex: ultrassom / cartão da gestante / teste de farmácia"
                    />
                    <Area label="Como pedir" rows={2} value={d.request_message} onChange={(v) => upd({ request_message: v })} />
                    <Area
                      label="Onde / como conseguir"
                      rows={3}
                      value={d.how_to_get}
                      onChange={(v) => upd({ how_to_get: v || null })}
                      hint="A IA usa quando o lead não sabe onde achar ou não tem em mãos."
                    />
                    <div className="grid2">
                      <Area
                        label="Por que precisamos"
                        rows={2}
                        value={d.why}
                        onChange={(v) => upd({ why: v || null })}
                        hint="A IA usa para reforçar quando ela não tem, recusa ou manda outro arquivo."
                      />
                      <Num
                        label="Quantas vezes insistir"
                        value={d.insist}
                        onChange={(v) => upd({ insist: v })}
                        hint="Depois disso vai como pendência para a equipe. Vazio = padrão."
                      />
                    </div>
                    <div className="f">
                      <span>Comprova quais perguntas</span>
                      <div className="chips">
                        {fieldKeys.map((key) => (
                          <label key={key} className={`chip${d.validates?.includes(key) ? ' on' : ''}`}>
                            <input type="checkbox" checked={!!d.validates?.includes(key)} onChange={() => toggleValidates(key)} /> {key}
                          </label>
                        ))}
                      </div>
                    </div>
                    <Text
                      label="Pedir só quando (opcional)"
                      value={d.condition}
                      onChange={(v) => upd({ condition: v || null })}
                      placeholder="Ex: já trabalhou com carteira assinada"
                      hint="Vazio = sempre. Se não se aplicar, a IA registra &quot;não se aplica&quot;."
                    />
                  </Card>
                );
              })}
              <button
                className="btn add"
                onClick={() => setAgent({ required_documents: [...docs, { key: '', label: '', file_types: ['image', 'pdf'], accepted: [], how_to_get: null, request_message: '', validates: [] }] })}
              >+ Adicionar documento</button>
            </>
          )}

          {section === 'classificacao' && (
            <>
              <h2>Rótulos de classificação</h2>
              <p className="muted">Avaliados em ordem. Se um rótulo tem regras e todas batem, classifica em código, sem LLM. Senão o qualifier (LLM) decide pela descrição.</p>
              {a.classification_labels.map((l, i) => (
                <Card
                  key={i}
                  title={<>{l.label || 'Novo rótulo'} <span className={`pill ${l.outcome}`}>{l.outcome === 'qualify' ? 'qualifica' : 'desqualifica'}</span></>}
                  onRemove={() => setAgent({ classification_labels: a.classification_labels.filter((_, j) => j !== i) })}
                  onUp={i > 0 ? () => setAgent({ classification_labels: move(a.classification_labels, i, -1) }) : undefined}
                  onDown={i < a.classification_labels.length - 1 ? () => setAgent({ classification_labels: move(a.classification_labels, i, 1) }) : undefined}
                >
                  <div className="grid3">
                    <Text label="Chave" value={l.key} onChange={(v) => setLabel(i, { key: v.replace(/\s+/g, '_') })} />
                    <Text label="Nome" value={l.label} onChange={(v) => setLabel(i, { label: v })} />
                    <label className="f">
                      <span>Resultado</span>
                      <select value={l.outcome} onChange={(e) => setLabel(i, { outcome: e.target.value as ClassificationLabel['outcome'] })}>
                        <option value="qualify">qualifica → handoff</option>
                        <option value="disqualify">desqualifica → perdido</option>
                      </select>
                    </label>
                  </div>
                  <Area label="Descrição (o qualifier lê isto)" rows={2} value={l.description} onChange={(v) => setLabel(i, { description: v })} />
                  {l.outcome === 'disqualify' && (
                    <Area label="Mensagem de desqualificação" rows={3} value={l.disqualify_message} onChange={(v) => setLabel(i, { disqualify_message: v || null })} />
                  )}
                  <div className="rules">
                    <span className="rules-title">Regras (todas precisam bater)</span>
                    {(l.rules ?? []).map((r, ri) => (
                      <RuleRow
                        key={`${i}-${ri}-${r.operator}`}
                        rule={r}
                        fields={fieldKeys}
                        onChange={(nr) => {
                          const rules = [...(l.rules ?? [])];
                          rules[ri] = nr;
                          setLabel(i, { rules });
                        }}
                        onRemove={() => setLabel(i, { rules: (l.rules ?? []).filter((_, j) => j !== ri) })}
                      />
                    ))}
                    <button
                      type="button"
                      className="btn add small"
                      onClick={() => setLabel(i, { rules: [...(l.rules ?? []), { field: fieldKeys[0] ?? '', operator: 'present' }] })}
                    >+ regra</button>
                  </div>
                </Card>
              ))}
              <button
                className="btn add"
                onClick={() => setAgent({ classification_labels: [...a.classification_labels, { key: '', label: '', description: '', outcome: 'qualify', rules: [] }] })}
              >+ Adicionar rótulo</button>
            </>
          )}

          {section === 'faq' && (
            <>
              <h2>FAQ</h2>
              {k.faq.map((q, i) => (
                <Card
                  key={i}
                  title={q.question || 'Nova pergunta'}
                  onRemove={() => setKitInfo({ faq: k.faq.filter((_, j) => j !== i) })}
                  onUp={i > 0 ? () => setKitInfo({ faq: move(k.faq, i, -1) }) : undefined}
                  onDown={i < k.faq.length - 1 ? () => setKitInfo({ faq: move(k.faq, i, 1) }) : undefined}
                >
                  <Text label="Pergunta" value={q.question} onChange={(v) => { const faq = [...k.faq]; faq[i] = { ...q, question: v }; setKitInfo({ faq }); }} />
                  <Area label="Resposta" rows={2} value={q.answer} onChange={(v) => { const faq = [...k.faq]; faq[i] = { ...q, answer: v }; setKitInfo({ faq }); }} />
                </Card>
              ))}
              <button className="btn add" onClick={() => setKitInfo({ faq: [...k.faq, { question: '', answer: '' }] })}>+ Adicionar pergunta</button>
            </>
          )}

          {section === 'followup' && (
            <>
              <h2>Follow-up por inatividade</h2>
              <p className="muted">Ainda não roda no simulador (Fase 2: sweep de follow-up). Fica salvo no kit.</p>
              {(a.followup_steps ?? []).map((s, i) => {
                const steps = a.followup_steps ?? [];
                const upd = (patch: Partial<typeof s>) => { const list = [...steps]; list[i] = { ...s, ...patch }; setAgent({ followup_steps: list }); };
                return (
                  <Card key={i} title={`Passo ${i + 1}`} onRemove={() => setAgent({ followup_steps: steps.filter((_, j) => j !== i).map((x, j) => ({ ...x, step: j + 1 })) })}>
                    <div className="grid3">
                      <Num label="Esperar (min)" value={s.delay_minutes} onChange={(v) => upd({ delay_minutes: v ?? 0 })} />
                      <label className="f f-check">
                        <input type="checkbox" checked={s.is_active} onChange={(e) => upd({ is_active: e.target.checked })} /> ativo
                      </label>
                    </div>
                    <Area label="Mensagem" rows={2} value={s.message} onChange={(v) => upd({ message: v })} />
                  </Card>
                );
              })}
              <button
                className="btn add"
                onClick={() => {
                  const steps = a.followup_steps ?? [];
                  setAgent({ followup_steps: [...steps, { step: steps.length + 1, delay_minutes: 60, message: '', is_active: true }] });
                }}
              >+ Adicionar passo</button>
              <Num label="Espera final antes de marcar perdido (min)" value={a.followup_final_wait_minutes} onChange={(v) => setAgent({ followup_final_wait_minutes: v })} />
            </>
          )}

          {section === 'json' && (
            <>
              <h2>kit.json bruto</h2>
              <p className="muted">Para campos sem editor (media_library, vision_context…). Salvar aqui usa o texto abaixo. O system prompt continua vindo da aba própria.</p>
              {jsonError && <div className="err">JSON inválido: {jsonError}</div>}
              <textarea
                className="mono prompt"
                spellCheck={false}
                value={jsonDraft}
                onChange={(e) => {
                  setJsonDraft(e.target.value);
                  try { setKit(JSON.parse(e.target.value)); setJsonError(null); } catch (err) { setJsonError((err as Error).message); }
                }}
              />
            </>
          )}
        </div>
      </section>
    </div>
  );
}
