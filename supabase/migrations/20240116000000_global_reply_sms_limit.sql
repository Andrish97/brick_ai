-- The extended-reply SMS cap becomes one global setting instead of a
-- per-user profile field — one place to control it for everyone.
INSERT INTO public.settings (key, value)
VALUES ('max_reply_sms_parts', '4')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_profile_max_reply_sms_parts_check;

ALTER TABLE public.users
  DROP COLUMN IF EXISTS profile_max_reply_sms_parts;
