// Aba "Fale Fácil + Bitrix": atendimento REAL no WhatsApp oficial (Fale Fácil) com o kanban de leads do Bitrix.
// Chaves ficam no servidor (fora do kit); o resto (mapas, templates) é salvo com o agente.
import { useEffect, useState } from 'react';
import { Copy, RefreshCw, Trash2 } from 'lucide-react';
import {
  api, defaultIntegration, type BitrixCatalog, type CrmStage, type FieldMapping, type IntegrationConfig, type IntegrationInfo,
  type LiveConversation, type RequiredField, type WhatsAppTemplate,
} from './api';
import { AiHealthCard, LiveReport } from './LiveReport';

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const varCount = (body: string) => Math.max(0, ...[...(body ?? '').matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1])));
const newId = () => `tpl_${Math.random().toString(36).slice(2, 8)}`;

function copy(text: string) { navigator.clipboard?.writeText(text).catch(() => {}); }

function SecretInput({ label, state, placeholder, hint, onSave }: {
  label: string; state?: { saved: boolean; hint: string | null }; placeholder: string; hint?: string; onSave: (v: string) => Promise<void>;
}) {
  const [v, setV] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <label className="f">
      <span>{label} {state?.saved ? <small className="ok">· salva ({state.hint})</small> : <small className="err">· não salva</small>}</span>
      <div className="int-secret">
        <input type="password" autoComplete="off" value={v} placeholder={state?.saved ? 'Digite para trocar' : placeholder} onChange={(e) => setV(e.target.value)} />
        <button type="button" className="btn small primary" disabled={!v.trim() || busy} onClick={async () => { setBusy(true); try { await onSave(v.trim()); setV(''); } finally { setBusy(false); } }}>
          Salvar
        </button>
        {state?.saved && (
          <button type="button" className="btn small danger" disabled={busy} title="Apagar" onClick={async () => { setBusy(true); try { await onSave(''); } finally { setBusy(false); } }}>
            Apagar
          </button>
        )}
      </div>
      {hint && <small>{hint}</small>}
    </label>
  );
}

function UrlRow({ label, url, hint }: { label: string; url: string; hint: string }) {
  return (
    <div className="f">
      <span>{label}</span>
      <div className="int-secret">
        <input readOnly value={url} onFocus={(e) => e.target.select()} />
        <button type="button" className="btn small" onClick={() => copy(url)}><Copy size={13} /> Copiar</button>
      </div>
      <small>{hint}</small>
    </div>
  );
}

/** Valor de um {{n}}: nome / dado da lead / texto fixo. */
function ParamPicker({ value, fields, onChange }: { value: string; fields: RequiredField[]; onChange: (v: string) => void }) {
  const mode = value === '{nome}' ? 'nome' : /^\{campo:/.test(value) ? 'campo' : 'fixo';
  return (
    <span className="int-param">
      <select value={mode === 'campo' ? value : mode} onChange={(e) => onChange(e.target.value === 'nome' ? '{nome}' : e.target.value === 'fixo' ? '' : e.target.value)}>
        <option value="nome">Primeiro nome</option>
        {fields.map((f) => <option key={f.key} value={`{campo:${f.key}}`}>Dado: {f.key}</option>)}
        <option value="fixo">Texto fixo…</option>
      </select>
      {mode === 'fixo' && <input value={value} placeholder="texto" onChange={(e) => onChange(e.target.value)} />}
    </span>
  );
}

export default function IntegrationEditor({ agentKey, value, templates, openingId, stages, fields, onChange }: {
  agentKey: string;
  value: IntegrationConfig | null | undefined;
  templates: WhatsAppTemplate[];
  openingId: string | null | undefined;
  stages: CrmStage[];
  fields: RequiredField[];
  onChange: (patch: { integration?: IntegrationConfig; templates?: WhatsAppTemplate[]; opening_template_id?: string | null }) => void;
}) {
  const cfg = { ...defaultIntegration(), ...(value ?? {}) };
  const set = (patch: Partial<IntegrationConfig>) => onChange({ integration: { ...cfg, ...patch } });
  const [info, setInfo] = useState<IntegrationInfo | null>(null);
  const [catalog, setCatalog] = useState<BitrixCatalog | null>(null);
  const [test, setTest] = useState<Record<string, { ok: boolean; detail: string }> | null>(null);
  const [account, setAccount] = useState<any[] | null>(null);
  const [convs, setConvs] = useState<LiveConversation[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState('');

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what); setErr(null);
    try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  };

  useEffect(() => {
    api.integration(agentKey).then(setInfo).catch((e) => setErr(e.message));
    api.liveConversations(agentKey).then((r) => setConvs(r.conversations)).catch(() => {});
  }, [agentKey]);

  const saveSecret = (k: 'falefacil_api_key' | 'falefacil_webhook_token' | 'bitrix_webhook_url') => async (v: string) => {
    await run('secret', async () => setInfo(await api.saveSecrets(agentKey, { [k]: v })));
  };

  const loadCatalog = () => run('catalog', async () => setCatalog(await api.bitrixCatalog(agentKey)));

  // sugere o mapa de etapas pelo nome (ex: "Pré-qualificado" ↔ "Pré-Qualificada")
  const suggestStages = () => {
    if (!catalog) return;
    const map = { ...cfg.stage_map };
    for (const st of stages) {
      if (map[st.id]) continue;
      const n = norm(st.name);
      const hit = catalog.stages.find((c) => norm(c.name) === n) ?? catalog.stages.find((c) => norm(c.name).slice(0, 9) === n.slice(0, 9));
      if (hit) map[st.id] = hit.id;
    }
    set({ stage_map: map });
  };

  const setTpl = (i: number, patch: Partial<WhatsAppTemplate>) => onChange({ templates: templates.map((t, j) => (j === i ? { ...t, ...patch } : t)) });
  const stageName = (id: string) => catalog?.stages.find((s) => s.id === id)?.name ?? id;
  const fieldLabel = (code: string) => catalog?.fields.find((f) => f.code === code)?.label ?? code;
  const setMap = (i: number, patch: Partial<FieldMapping>) => set({ field_map: cfg.field_map.map((m, j) => (j === i ? { ...m, ...patch } : m)) });
  const keyOptions = ['nome', ...fields.map((f) => f.key)];

  return (
    <>
      <h2>Fale Fácil + Bitrix (atendimento real)</h2>
      <p className="muted">
        A IA atende no WhatsApp oficial pelo Fale Fácil e move o card no kanban de leads do Bitrix. A mensagem da lead chega pelo
        webhook do Fale Fácil; o motor acha o lead pelo telefone, roda o mesmo fluxo do simulador e responde pelo Fale Fácil.
      </p>
      {err && <div className="alert warning">{err}</div>}

      <AiHealthCard agentKey={agentKey} />

      <div className="fu-box">
        <label className="f f-check" style={{ paddingTop: 0 }}>
          <input type="checkbox" checked={cfg.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          <strong>Atendimento real ligado</strong> (salve o agente para valer). Desligado, o que chegar pelo webhook é ignorado.
        </label>
        <label className="f">
          <span>Só atender estes telefones (teste) - um por linha. Vazio = todos os leads.</span>
          <textarea rows={2} value={cfg.test_phones.join('\n')} placeholder="5511999990000" onChange={(e) => set({ test_phones: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) })} />
        </label>
      </div>

      <h3>1. Chaves e endereços</h3>
      <p className="muted">Ficam só no servidor (não vão para o kit.json nem são copiadas ao duplicar o agente).</p>
      <SecretInput label="API key do Fale Fácil" state={info?.secrets.falefacil_api_key} placeholder="chave da conexão" onSave={saveSecret('falefacil_api_key')}
        hint="Painel do Fale Fácil → Minhas Conexões → a conexão do número → API." />
      <SecretInput label="Token de validação do webhook (Fale Fácil)" state={info?.secrets.falefacil_webhook_token} placeholder="X-Webhook-Token" onSave={saveSecret('falefacil_webhook_token')}
        hint="Configurações da conexão → aba Desenvolvedor → Token de validação. Com ele, só o Fale Fácil consegue chamar o nosso webhook." />
      <SecretInput label="Webhook de entrada do Bitrix" state={info?.secrets.bitrix_webhook_url} placeholder="https://prevx.bitrix24.com.br/rest/61/xxxxxxxx/" onSave={saveSecret('bitrix_webhook_url')}
        hint="Bitrix → Aplicativos → Recursos para desenvolvedores → Outros → Webhook de entrada. Permissões: CRM, Usuários, Canais Abertos." />
      {info && (
        <>
          <UrlRow label="Endpoint de destino no Fale Fácil" url={info.urls.falefacil_webhook}
            hint="Cole em Configurações da conexão → Desenvolvedor → Endpoint de destino, e salve lá." />
          <UrlRow label="Webhook do Bitrix para lead novo (só no modo &quot;o motor envia o template&quot;)" url={info.urls.bitrix_lead_webhook}
            hint="Na automação da etapa Indeterminado, robô &quot;Webhook&quot; chamando esta URL (o Bitrix troca {{ID}} pelo id do lead)." />
        </>
      )}
      <div className="int-actions">
        <button type="button" className="btn small" disabled={!!busy} onClick={() => run('test', async () => setTest(await api.testIntegration(agentKey)))}>Testar conexões</button>
        <button type="button" className="btn small" disabled={!!busy} onClick={() => { if (confirm('Gerar URLs novas? As antigas param de funcionar.')) run('regen', async () => setInfo(await api.regenerateHooks(agentKey))); }}>
          <RefreshCw size={13} /> Gerar URLs novas
        </button>
        {test && Object.entries(test).map(([k, r]) => <span key={k} className={r.ok ? 'ok' : 'err'}>{k === 'falefacil' ? 'Fale Fácil' : 'Bitrix'}: {r.ok ? '✓' : '✗'} {r.detail}</span>)}
      </div>

      <h3>2. Templates da Meta</h3>
      <p className="muted">
        A PrevX cria e aprova os templates no WhatsApp Manager e passa o nome e o texto; aqui só cadastramos. Fora da janela de 24h
        (lead sem responder há mais de um dia, ou antes da 1ª mensagem dela) só sai template.
      </p>
      {templates.map((t, i) => {
        const n = varCount(t.body);
        const params = Array.from({ length: n }, (_, j) => t.params?.[j] ?? (j === 0 ? '{nome}' : ''));
        return (
          <div key={t.id} className="fu-box">
            <div className="int-tpl-head">
              <label className="f"><span>Nome na Meta (exato)</span><input value={t.name} placeholder="atendimento_4" onChange={(e) => setTpl(i, { name: e.target.value.trim() })} /></label>
              <label className="f f-num"><span>Idioma</span><input value={t.lang ?? 'pt_BR'} onChange={(e) => setTpl(i, { lang: e.target.value.trim() })} /></label>
              <button type="button" className="icon-btn danger" title="Remover" onClick={() => onChange({
                templates: templates.filter((_, j) => j !== i), ...(openingId === t.id ? { opening_template_id: null } : {}),
              })}><Trash2 size={14} /></button>
            </div>
            <label className="f">
              <span>Texto aprovado (com {'{{1}}'}, {'{{2}}'}… como foi criado na Meta)</span>
              <textarea rows={3} value={t.body} onChange={(e) => setTpl(i, { body: e.target.value })} />
              <small>Vai para o histórico: a IA sabe o que a lead leu.</small>
            </label>
            {n > 0 && (
              <div className="f">
                <span>Variáveis</span>
                {params.map((p, j) => (
                  <div key={j} className="int-var"><code>{`{{${j + 1}}}`}</code>
                    <ParamPicker value={p} fields={fields} onChange={(v) => setTpl(i, { params: params.map((x, k) => (k === j ? v : x)) })} />
                  </div>
                ))}
              </div>
            )}
            <label className="f"><span>Observação (categoria, para que serve…)</span><input value={t.note ?? ''} onChange={(e) => setTpl(i, { note: e.target.value || null })} /></label>
          </div>
        );
      })}
      <div className="int-actions">
        <button type="button" className="btn add small" onClick={() => onChange({ templates: [...templates, { id: newId(), name: '', lang: 'pt_BR', body: '', params: [] }] })}>+ Template</button>
        <button type="button" className="btn small" disabled={!!busy} onClick={() => run('acc', async () => setAccount((await api.accountTemplates(agentKey)).templates))}>
          Ver templates aprovados na conta
        </button>
      </div>
      {account && (
        <div className="fu-box">
          {!account.length && <small className="muted">Nenhum template aprovado retornado.</small>}
          {account.map((t: any) => {
            const body = (t.components ?? []).find((c: any) => c.type === 'BODY')?.text ?? '';
            return (
              <div key={`${t.name}-${t.language}`} className="int-acc">
                <span><strong>{t.name}</strong> <small className="muted">{t.language} · {t.category}</small><br /><small>{body}</small></span>
                <button type="button" className="btn small" disabled={templates.some((x) => x.name === t.name)}
                  onClick={() => onChange({ templates: [...templates, { id: newId(), name: t.name, lang: t.language, body, params: [] }] })}>Cadastrar</button>
              </div>
            );
          })}
        </div>
      )}

      <h3>3. Abertura da conversa (lead de formulário)</h3>
      <label className="f">
        <span>Quem manda o template de abertura</span>
        <select value={cfg.opening_mode} onChange={(e) => set({ opening_mode: e.target.value as IntegrationConfig['opening_mode'] })}>
          <option value="external">A automação do Bitrix (robô do Fale Fácil, como hoje) - a IA assume quando a lead responder</option>
          <option value="engine">O motor - o Bitrix avisa que o lead entrou (robô Webhook) e a IA manda o template</option>
        </select>
      </label>
      <label className="f">
        <span>Template de abertura</span>
        <select value={openingId ?? ''} onChange={(e) => onChange({ opening_template_id: e.target.value || null })}>
          <option value="">— nenhum —</option>
          {templates.filter((t) => t.name).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <small>
          {cfg.opening_mode === 'external'
            ? 'Use o mesmo que o robô envia (hoje: atendimento_4): o texto entra no histórico e a recepção não é repetida.'
            : 'O motor envia este template. No simulador, o botão "Iniciar" também usa este template.'}
        </small>
      </label>

      <h3>4. Bitrix: etapas, responsável e campos</h3>
      <div className="int-actions">
        <button type="button" className="btn small primary" disabled={!!busy || !info?.secrets.bitrix_webhook_url.saved} onClick={loadCatalog}>
          {busy === 'catalog' ? 'Carregando…' : catalog ? 'Recarregar do Bitrix' : 'Carregar etapas, usuários e campos do Bitrix'}
        </button>
        {catalog && <small className="muted">{catalog.stages.length} etapas · {catalog.users.length} usuários · {catalog.fields.length} campos · {catalog.queues.length} canais</small>}
      </div>
      {catalog?.warnings.map((w) => <div key={w} className="warn-inline">{w}</div>)}
      {!catalog && <p className="muted">Sem carregar, os seletores mostram só os ids já salvos.</p>}

      <h4>Etapa do agente → etapa do Bitrix</h4>
      <p className="muted">As etapas do agente são as da aba CRM / Kanban (onde cada marco move o card).</p>
      <div className="crm-table">
        {stages.map((st) => (
          <div key={st.id} className="crm-row int-row">
            <span className="crm-event"><strong>{st.name}</strong><small><code>{st.id}</code></small></span>
            <select value={cfg.stage_map[st.id] ?? ''} onChange={(e) => set({ stage_map: { ...cfg.stage_map, [st.id]: e.target.value } })}>
              <option value="">— não mover no Bitrix —</option>
              {(catalog?.stages ?? []).map((c) => <option key={c.id} value={c.id}>{c.name} ({c.id})</option>)}
              {!catalog && cfg.stage_map[st.id] && <option value={cfg.stage_map[st.id]}>{cfg.stage_map[st.id]}</option>}
            </select>
          </div>
        ))}
        {!stages.length && <small className="muted">Cadastre as etapas na aba CRM / Kanban.</small>}
      </div>
      {catalog && <button type="button" className="btn small" onClick={suggestStages}>Sugerir pelo nome</button>}

      <h4>Etapas em que a IA atende</h4>
      <p className="muted">Card fora delas = a equipe assumiu: a IA não responde nem manda follow-up. Nenhuma marcada = todas.</p>
      <div className="int-checks">
        {(catalog?.stages ?? cfg.active_stages.map((id) => ({ id, name: id }))).map((c) => (
          <label key={c.id} className="f f-check">
            <input type="checkbox" checked={cfg.active_stages.includes(c.id)}
              onChange={(e) => set({ active_stages: e.target.checked ? [...cfg.active_stages, c.id] : cfg.active_stages.filter((x) => x !== c.id) })} />
            {c.name}
          </label>
        ))}
      </div>

      <h4>Passou para a equipe</h4>
      <p className="muted">A etapa (ex: Pré-qualificada) vem do marco na aba CRM / Kanban. Aqui: quem assume o lead e para quem vai o chat.</p>
      <div className="grid2">
        <label className="f">
          <span>Responsável do lead</span>
          <select value={cfg.handoff.assign_user_id ?? ''} onChange={(e) => set({ handoff: { ...cfg.handoff, assign_user_id: e.target.value || null } })}>
            <option value="">— não trocar —</option>
            {(catalog?.users ?? []).map((u) => <option key={u.id} value={u.id}>{u.name} (#{u.id})</option>)}
            {!catalog && cfg.handoff.assign_user_id && <option value={cfg.handoff.assign_user_id}>#{cfg.handoff.assign_user_id}</option>}
          </select>
        </label>
        <label className="f">
          <span>Transferir o chat (Canal Aberto) para</span>
          <div className="int-secret">
            <select value={cfg.handoff.transfer_type} onChange={(e) => set({ handoff: { ...cfg.handoff, transfer_type: e.target.value as 'user' | 'queue', transfer_id: null } })}>
              <option value="user">usuário</option>
              <option value="queue">fila</option>
            </select>
            <select value={cfg.handoff.transfer_id ?? ''} onChange={(e) => set({ handoff: { ...cfg.handoff, transfer_id: e.target.value || null } })}>
              <option value="">— não transferir —</option>
              {(cfg.handoff.transfer_type === 'user' ? catalog?.users ?? [] : catalog?.queues ?? []).map((u) => <option key={u.id} value={u.id}>{u.name} (#{u.id})</option>)}
              {!catalog && cfg.handoff.transfer_id && <option value={cfg.handoff.transfer_id}>#{cfg.handoff.transfer_id}</option>}
            </select>
          </div>
        </label>
      </div>

      <h4>Campos do lead ↔ dados do atendimento</h4>
      <p className="muted">
        Leitura: o que o formulário gravou no lead vira dado conhecido (a IA confirma em vez de perguntar). Nome vem de Nome/Sobrenome.
        "Gravar no Bitrix": quando a IA coletar ou corrigir o dado, atualiza o campo.
      </p>
      {cfg.field_map.length > 0 && <div className="crm-table">
        {cfg.field_map.map((m, i) => (
          <div key={i} className="crm-row int-map">
            <select value={m.crm_field} onChange={(e) => setMap(i, { crm_field: e.target.value })}>
              <option value="">— campo do Bitrix —</option>
              {(catalog?.fields ?? []).map((f) => <option key={f.code} value={f.code}>{f.label}</option>)}
              {!catalog?.fields.some((f) => f.code === m.crm_field) && m.crm_field && <option value={m.crm_field}>{m.crm_field}</option>}
            </select>
            <span>→</span>
            <span className="int-param">
              <select value={keyOptions.includes(m.key) ? m.key : '__livre'} onChange={(e) => setMap(i, { key: e.target.value === '__livre' ? fieldLabel(m.crm_field) : e.target.value })}>
                {fields.map((f) => <option key={f.key} value={f.key}>Pergunta: {f.key}</option>)}
                <option value="nome">nome</option>
                <option value="__livre">Contexto (rótulo livre)…</option>
              </select>
              {!keyOptions.includes(m.key) && <input value={m.key} onChange={(e) => setMap(i, { key: e.target.value })} />}
            </span>
            <label className="f f-check" style={{ paddingTop: 0 }}>
              <input type="checkbox" checked={!!m.write_back} onChange={(e) => setMap(i, { write_back: e.target.checked })} /> gravar no Bitrix
            </label>
            <button type="button" className="icon-btn danger" onClick={() => set({ field_map: cfg.field_map.filter((_, j) => j !== i) })}><Trash2 size={14} /></button>
          </div>
        ))}
      </div>}
      <button type="button" className="btn add small" onClick={() => set({ field_map: [...cfg.field_map, { crm_field: '', key: fields[0]?.key ?? 'nome' }] })}>+ Campo</button>

      <label className="f f-check">
        <input type="checkbox" checked={cfg.mirror_to_timeline} onChange={(e) => set({ mirror_to_timeline: e.target.checked })} />
        Copiar as mensagens da IA na timeline do lead (a API oficial não mostra no chat do Bitrix o que a IA envia).
      </label>

      <h3>5. Conversas reais de hoje</h3>
      <div className="int-actions">
        <button type="button" className="btn small" onClick={() => run('convs', async () => setConvs((await api.liveConversations(agentKey)).conversations))}>
          <RefreshCw size={13} /> Atualizar
        </button>
      </div>
      {convs && !convs.length && <p className="muted">Nenhuma conversa real hoje.</p>}
      {!!convs?.length && (
        <div className="crm-table">
          {convs.map((c) => (
            <div key={c.id} className="crm-row int-conv">
              <span className="crm-event">
                <strong>{c.phone} {c.leadUrl && <a href={c.leadUrl} target="_blank" rel="noreferrer">lead #{c.leadId}</a>}</strong>
                <small>{c.status}{c.classification ? ` · ${c.classification}` : ''}{c.stage ? ` · ${stages.find((s) => s.id === c.stage)?.name ?? stageName(c.stage)}` : ''} · {c.messages} msgs · {new Date(c.updatedAt).toLocaleString('pt-BR')}</small>
                {c.last && <small className="muted">{c.last.role === 'user' ? 'Lead' : 'IA'}: {c.last.body || `[${c.last.type}]`}</small>}
              </span>
              <button type="button" className="btn small danger" title="Apaga só o registro aqui; a próxima mensagem recomeça do zero"
                onClick={() => { if (confirm(`Apagar a conversa de ${c.phone} aqui? (não mexe no WhatsApp nem no Bitrix)`)) run('del', async () => { await api.resetLiveConversation(agentKey, c.id); setConvs(convs.filter((x) => x.id !== c.id)); }); }}>
                Recomeçar
              </button>
            </div>
          ))}
        </div>
      )}

      <LiveReport agentKey={agentKey} />
    </>
  );
}
