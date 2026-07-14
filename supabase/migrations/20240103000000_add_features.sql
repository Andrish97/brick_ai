-- Dodaj system_prompt do tabeli users
alter table public.users add column if not exists system_prompt text;

-- Tabela logów webhooków
create table if not exists public.webhook_logs (
  id          uuid primary key default gen_random_uuid(),
  raw_payload jsonb not null,
  created_at  timestamptz not null default now()
);

alter table public.webhook_logs enable row level security;

-- RLS policies dla roli authenticated

-- users
create policy "authenticated full access on users"
  on public.users
  for all
  to authenticated
  using (true)
  with check (true);

-- conversations
create policy "authenticated full access on conversations"
  on public.conversations
  for all
  to authenticated
  using (true)
  with check (true);

-- messages
create policy "authenticated full access on messages"
  on public.messages
  for all
  to authenticated
  using (true)
  with check (true);

-- webhook_logs
create policy "authenticated full access on webhook_logs"
  on public.webhook_logs
  for all
  to authenticated
  using (true)
  with check (true);
