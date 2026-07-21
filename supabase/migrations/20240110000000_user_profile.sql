-- Pola profilu użytkownika przekazywane do kontekstu AI
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'profile_name'
  ) THEN
    ALTER TABLE public.users ADD COLUMN profile_name text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'profile_home'
  ) THEN
    ALTER TABLE public.users ADD COLUMN profile_home text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'profile_work'
  ) THEN
    ALTER TABLE public.users ADD COLUMN profile_work text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'profile_transport'
  ) THEN
    ALTER TABLE public.users ADD COLUMN profile_transport text;
  END IF;

END;
$$;
