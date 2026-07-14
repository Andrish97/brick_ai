create table if not exists public.logs (
  id         uuid primary key default gen_random_uuid(),
  type       text not null,
  data       jsonb,
  created_at timestamptz not null default now()
);

alter table public.logs enable row level security;

create policy "auth_logs_all" on public.logs
  for all to authenticated using (true) with check (true);

create index logs_created_at_idx on public.logs (created_at desc);
create index logs_type_idx on public.logs (type);
