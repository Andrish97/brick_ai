ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS reply_sms_parts smallint NOT NULL DEFAULT 1;

ALTER TABLE public.conversations
  DROP CONSTRAINT IF EXISTS conversations_reply_sms_parts_check;

ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_reply_sms_parts_check
  CHECK (reply_sms_parts IN (1, 3, 4));
