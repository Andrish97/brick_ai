-- Conversations table: stores SMS chat history per phone number
create table if not exists public.conversations (
  id          bigserial primary key,
  phone_number text      not null,
  role        text      not null check (role in ('user', 'assistant')),
  content     text      not null,
  created_at  timestamptz not null default now()
);

create index if not exists idx_conversations_phone_created
  on public.conversations (phone_number, created_at);

-- Call events table: stores Zadarma call lifecycle events
create table if not exists public.call_events (
  id          bigserial primary key,
  event_type  text      not null,
  caller_id   text,
  called_did  text,
  call_id     text,
  disposition text,
  duration    integer,
  record_url  text,
  raw_payload jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists idx_call_events_caller
  on public.call_events (caller_id, created_at);

-- RLS: deny all public access (service role key bypasses RLS)
alter table public.conversations enable row level security;
alter table public.call_events   enable row level security;
