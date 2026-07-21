ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS pending_reply text;
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS extended_mode boolean NOT NULL DEFAULT false;
