insert into public.settings (key, value) values
  ('rail_min_transfer_minutes', '30'),
  ('rail_max_transfer_minutes', '150'),
  ('rail_origin_window_hours', '4')
on conflict (key) do nothing;
