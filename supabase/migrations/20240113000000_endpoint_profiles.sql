-- Endpoint-driven assistant: per-user response cap and preferred rail stations.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS profile_max_reply_sms_parts smallint NOT NULL DEFAULT 4,
  ADD COLUMN IF NOT EXISTS profile_home_station text,
  ADD COLUMN IF NOT EXISTS profile_work_station text;

ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_profile_max_reply_sms_parts_check;

ALTER TABLE public.users
  ADD CONSTRAINT users_profile_max_reply_sms_parts_check
  CHECK (profile_max_reply_sms_parts IN (1, 3, 4));

-- Natural-language tools replace all configurable SMS commands.
DELETE FROM public.settings
WHERE key IN (
  'close_keywords',
  'nav_keyword',
  'continue_keyword',
  'extended_on_keyword',
  'extended_off_keyword'
);
