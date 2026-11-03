# 08. Modelo de dados (proposto para o projeto novo)

> **Decisão (2026-11-02): banco = MongoDB, cache/filas = Redis.** O SQL abaixo continua como referência do modelo vindo do Laravel; ao implementar, cada tabela vira uma collection (ODM: Mongoose). Redis cuida de debounce, locks e BullMQ.

~~Postgres. Use Prisma ou Drizzle~~; abaixo em SQL para ficar neutro. Origem: migrations em `referencia-laravel/database/migrations/`.

**Fase 1** precisa só de: `kits`, `agents`, `playground_sessions`, `ai_usages`, `ai_agent_logs`, `ai_models`.
**Fase 2** adiciona: `channels`, `contacts`, `pipeline_stages`, `chats`, `messages`, `conversations`.

```sql
-- ===== FASE 1 =====
create table kits (
  id            bigserial primary key,
  workspace_id  bigint not null,             -- "tenant" (multi-cliente)
  name          text not null,
  category      text,
  company_info  text,
  faq           jsonb not null default '[]', -- [{question, answer}]
  media_library jsonb not null default '[]', -- [{id,type,path,mime,file_name,caption,when_to_use,send_on_handoff}]
  vision_context jsonb,                      -- NOVO: {intro, document_types[], react_to_types[]}  (era hardcoded INSS)
  is_active     boolean not null default true,
  created_at timestamptz default now(), updated_at timestamptz default now()
);

create table agents (
  id                bigserial primary key,
  workspace_id      bigint not null,
  kit_id            bigint references kits(id) on delete cascade,
  role              text not null default 'sdr',
  name              text not null,
  provider          text not null,              -- together|openai|anthropic|deepseek
  model             text not null,
  models            jsonb,                      -- {responder,extractor,qualifier,vision}
  api_key_enc       text,                       -- criptografado (AES-GCM)
  system_prompt     text not null,
  greeting_example  text,
  consent_message   text,
  required_fields   jsonb not null default '[]',  -- [{key,label,question}]
  classification_labels jsonb not null default '[]',
  handoff_message   text,
  disqualify_message text,
  fallback_message  text,
  handoff_keywords  jsonb not null default '[]',
  max_turns         smallint not null default 20,
  debounce_seconds  smallint not null default 8,
  followup_steps    jsonb not null default '[]',  -- [{step,delay_minutes,message,is_active}]
  followup_final_wait_minutes int,
  followup_lost_reason_id bigint,
  -- fase 2:
  channel_id        bigint,                     -- conexão WhatsApp
  trigger_stage_id  bigint,                     -- etapa "Onboarding"
  log_executions    boolean not null default true,
  is_active         boolean not null default true,
  created_at timestamptz default now(), updated_at timestamptz default now()
);

create table playground_sessions (
  id              bigserial primary key,
  agent_id        bigint references agents(id) on delete cascade,
  user_id         bigint,
  phone           text not null default '5511999999999', -- define o DDD simulado
  status          text not null default 'active',         -- active|handed_off
  turns_count     int not null default 0,
  opening_completed boolean not null default false,
  classification  text,
  custom_fields   jsonb not null default '{}',  -- pode ser pré-preenchido p/ simular lead de formulário
  sent_media_ids  jsonb not null default '[]',
  messages        jsonb not null default '[]',  -- [{id(ulid),role:user|assistant|event,type,body,created_at,media_path?,file_name?,transcript?,ai_analysis?,reply_to?,reason?,classification?,confidence?}]
  created_at timestamptz default now(), updated_at timestamptz default now()
);

create table ai_models (
  id bigserial primary key,
  provider text not null, model_id text not null, label text,
  capabilities jsonb not null default '[]',      -- chat|tools|vision|transcription
  price_input numeric, price_cached numeric, price_output numeric, price_audio_minute numeric,
  recommended_for jsonb not null default '[]',   -- roles
  unique (provider, model_id)
);

create table ai_usages (
  id bigserial primary key,
  workspace_id bigint, agent_id bigint, contact_id bigint, session_id bigint,
  step text not null,               -- extractor|qualifier|responder|vision|transcription
  provider text not null, model text not null,
  input_tokens int default 0, cached_tokens int default 0, output_tokens int default 0,
  audio_seconds numeric,
  price_input numeric, price_cached numeric, price_output numeric, price_audio_minute numeric, -- snapshot
  cost_usd numeric(12,6) not null default 0,
  log_id bigint,
  created_at timestamptz default now()
);

create table ai_agent_logs (
  id bigserial primary key,
  agent_id bigint, contact_id bigint, session_id bigint,
  step text not null,
  system_prompt text, user_message text, raw_response jsonb,
  created_at timestamptz default now()
);

-- ===== FASE 2 =====
create table channels (           -- conexão WhatsApp
  id bigserial primary key, workspace_id bigint not null,
  provider text not null,         -- evolution|meta
  name text, config jsonb         -- instance, token, phone_number_id...
);

create table pipeline_stages (
  id bigserial primary key, workspace_id bigint not null,
  name text not null, position int not null,
  role text                       -- onboarding|in_progress|won|lost|null
);

create table contacts (
  id bigserial primary key, workspace_id bigint not null,
  phone text not null, name text,
  custom_fields jsonb not null default '{}',
  stage_id bigint references pipeline_stages(id), stage_position int,
  assigned_to_name text,
  automation_paused boolean not null default false,
  lost_reason_id bigint, lost_at timestamptz,
  notes text,
  unique (workspace_id, phone)
);

create table chats (
  id bigserial primary key, workspace_id bigint, channel_id bigint,
  customer_phone text not null, customer_name text, last_message_at timestamptz,
  unique (channel_id, customer_phone)
);

create table messages (
  id bigserial primary key,       -- ORDENAR HISTÓRICO POR ESTE ID
  chat_id bigint references chats(id) on delete cascade,
  external_id text,               -- id do provedor (necessário p/ reação)
  direction text not null,        -- inbound|outbound
  type text not null,             -- text|audio|image|document|video|sticker|reaction|internal_note
  body text, media_url text,
  transcript text,
  ai_analysis jsonb,              -- resultado da visão ou {failed:true}
  reply_to_id bigint,
  sent_at timestamptz, status text,
  created_at timestamptz default now()
);
create index on messages (chat_id, id desc);

create table conversations (      -- estado da IA por (agente, contato)
  id bigserial primary key, workspace_id bigint,
  agent_id bigint references agents(id) on delete cascade,
  contact_id bigint references contacts(id) on delete cascade,
  status text not null default 'active',   -- active|handing_off|handed_off
  turns_count int not null default 0,
  opening_completed boolean not null default false,
  classification text, handoff_reason text,
  followup_step_sent int not null default 0,
  sent_media_ids jsonb,
  last_inbound_at timestamptz, started_at timestamptz, completed_at timestamptz,
  unique (agent_id, contact_id)
);
```

## Formato JSON das labels de classificação
```json
{
  "key": "elegivel_urgente",
  "label": "Elegível - Urgente",
  "description": "texto que o LLM lê para decidir",
  "outcome": "qualify",
  "rules": [{ "field": "data_saida_ctps", "operator": "months_since_gte", "value": 9 }],
  "disqualify_message": "só quando outcome=disqualify",
  "lost_reason_id": null,
  "chat_label_id": null
}
```
