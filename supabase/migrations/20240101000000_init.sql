create table if not exists public.users (
  id           uuid primary key default gen_random_uuid(),
  code         char(4) unique not null,
  phone_number text,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

create table if not exists public.conversations (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.users(id),
  code             char(6) unique not null,
  status           text not null check (status in ('active','closed')) default 'active',
  summary          text,
  created_at       timestamptz not null default now(),
  last_activity_at timestamptz not null default now()
);

create table if not exists public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id),
  direction       text not null check (direction in ('in','out')),
  content         text not null,
  created_at      timestamptz not null default now()
);

create index if not exists idx_conversations_user on public.conversations(user_id);
create index if not exists idx_messages_conversation on public.messages(conversation_id, created_at);

alter table public.users         enable row level security;
alter table public.conversations enable row level security;
alter table public.messages      enable row level security;
