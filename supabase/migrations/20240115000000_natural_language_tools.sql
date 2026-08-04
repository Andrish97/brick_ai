-- Natural-language function calling replaces the old keyword commands; the
-- webhook no longer reads nav/continue/extended keywords from settings or code.
DELETE FROM public.settings
WHERE key IN ('close_keywords');

-- Driving is removed from navigation to keep routes short enough for SMS
-- (a road route can be many turns / km; walking, cycling, scooter and
-- transit stay short and predictable). Reset any profile stuck on it so
-- get_directions doesn't silently fail for those users.
UPDATE public.users SET profile_transport = NULL WHERE profile_transport = 'samochód';

ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_profile_transport_check;

ALTER TABLE public.users
  ADD CONSTRAINT users_profile_transport_check
  CHECK (profile_transport IS NULL OR profile_transport IN ('pieszo', 'rower', 'hulajnoga', 'komunikacja miejska'));
