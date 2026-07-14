# Zadarma AI Agent

Supabase Edge Functions that connect Zadarma SMS/calls with Claude AI.

## Struktura

```
zadarma-ai-agent/
  supabase/
    functions/
      zadarma-sms-webhook/   # odbiera SMS, odpowiada przez Claude
      zadarma-call-webhook/  # loguje zdarzenia połączeń
    migrations/
      20240101000000_init.sql
    config.toml
  .github/workflows/deploy.yml
  .env.example
```

## Setup lokalny

### 1. Zainstaluj Supabase CLI

```bash
brew install supabase/tap/supabase
```

### 2. Zaloguj się i zlinkuj projekt

```bash
supabase login
supabase link --project-ref <twój-project-ref>
```

### 3. Ustaw sekrety produkcyjne

```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase secrets set ZADARMA_API_KEY=...
supabase secrets set ZADARMA_API_SECRET=...
supabase secrets set SYSTEM_PROMPT="Jesteś pomocnym asystentem AI..."
```

### 4. Uruchom migracje

```bash
supabase db push
```

### 5. Testuj lokalnie

```bash
cp .env.example .env.local
# wypełnij .env.local prawdziwymi wartościami

supabase functions serve --env-file .env.local
# funkcja dostępna na http://localhost:54321/functions/v1/zadarma-sms-webhook
```

Wyślij testowy webhook:

```bash
curl -X POST http://localhost:54321/functions/v1/zadarma-sms-webhook \
  -H "Content-Type: application/json" \
  -d '{"event":"sms","sms_from":"+48123456789","sms_to":"+48987654321","msg":"Cześć!"}'
```

### 6. Deploy ręczny

```bash
supabase functions deploy zadarma-sms-webhook --no-verify-jwt
supabase functions deploy zadarma-call-webhook --no-verify-jwt
```

## GitHub Actions (auto-deploy)

Ustaw sekrety w repozytorium GitHub:
- `SUPABASE_ACCESS_TOKEN` — token z [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens)
- `SUPABASE_PROJECT_REF` — ref projektu (np. `abcdefghijklmnop`)
- `SUPABASE_DB_PASSWORD` — hasło do bazy (z ustawień projektu)

Po każdym push na `main` funkcje są deployowane automatycznie.

## Zadarma — ręczna konfiguracja (musisz zrobić sam)

1. Wejdź w panel Zadarma → **Moje numery** → wybierz numer → **Webhooki**
2. Wklej URL: `https://<project-ref>.supabase.co/functions/v1/zadarma-sms-webhook`
3. Zaznacz zdarzenia: `Przychodzący SMS`
