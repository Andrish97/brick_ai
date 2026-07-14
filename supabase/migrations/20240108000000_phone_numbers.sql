-- Create phone_numbers table
CREATE TABLE IF NOT EXISTS public.phone_numbers (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  number      text        NOT NULL,
  description text,
  sort_order  int         NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.phone_numbers ENABLE ROW LEVEL SECURITY;

-- Policy: all operations for authenticated users
CREATE POLICY auth_phone_numbers_all
  ON public.phone_numbers
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- Add phone_number_id column to users (if not exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'users'
      AND column_name  = 'phone_number_id'
  ) THEN
    ALTER TABLE public.users
      ADD COLUMN phone_number_id uuid REFERENCES public.phone_numbers(id) ON DELETE SET NULL;
  END IF;
END;
$$;

-- Insert default settings
INSERT INTO public.settings (key, value)
VALUES
  ('sms_count', '0'),
  ('sms_price', '0.18')
ON CONFLICT (key) DO NOTHING;

-- Function: atomically increment sms_count
CREATE OR REPLACE FUNCTION public.increment_sms_count()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
  INSERT INTO public.settings(key, value)
  VALUES ('sms_count', '1')
  ON CONFLICT (key) DO UPDATE
    SET value      = (public.settings.value::bigint + 1)::text,
        updated_at = now();
$$;
