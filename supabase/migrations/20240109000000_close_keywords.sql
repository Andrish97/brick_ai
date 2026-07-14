insert into public.settings (key, value)
values ('close_keywords', 'koniec,stop,zamknij,end')
on conflict (key) do nothing;
