create table if not exists public.settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

insert into public.settings (key, value) values
  ('zadarma_caller_id', '48459569689')
on conflict (key) do nothing;

alter table public.settings enable row level security;

create policy "auth_settings_all" on public.settings
  for all to authenticated using (true) with check (true);
