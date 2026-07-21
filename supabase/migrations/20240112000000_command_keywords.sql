insert into public.settings (key, value)
values
  ('nav_keyword',         'nav'),
  ('continue_keyword',    '-->'),
  ('extended_on_keyword', '->'),
  ('extended_off_keyword','<-')
on conflict (key) do nothing;
