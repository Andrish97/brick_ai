# Brick AI — SMS Gateway

AI asystent dostępny przez SMS. Użytkownik wysyła SMS z kodem → Gemini/DeepSeek odpowiada w 160 znakach.

## Jak to działa

```
Użytkownik → SMS → Zadarma → webhook → Supabase Edge Function → Gemini/DeepSeek → SMS odpowiedź
```

**Format SMS od użytkownika:**
```
1234          ← kod użytkownika (4 cyfry)
789012        ← kod rozmowy (6 cyfr) — opcjonalny, brak = nowa rozmowa
treść wiadomości
```

**Odpowiedź (max 160 znaków):**
```
Odpowiedź AI (max 153 znaki)
789012
```

---

## Setup od zera

### 1. Supabase

1. Utwórz projekt na [supabase.com](https://supabase.com)
2. Zapisz:
   - **Project ref** (z URL: `supabase.com/dashboard/project/<REF>`)
   - **Anon key** → Project Settings → API → `anon public`
   - **DB connection string (pooler)** → Connect → Transaction pooler

### 2. GitHub repo

1. Forkuj lub sklonuj to repo
2. **Settings → Secrets and variables → Actions** — dodaj:

| Sekret | Skąd wziąć |
|--------|-----------|
| `SUPABASE_ACCESS_TOKEN` | [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens) |
| `SUPABASE_PROJECT_REF` | 20-znakowy ref z URL projektu |
| `SUPABASE_DB_URL` | `postgresql://postgres.REF:[HASŁO]@aws-0-XX.pooler.supabase.com:5432/postgres` |

3. **Settings → Pages → Source: GitHub Actions**

### 3. Zaktualizuj panel admina

W pliku `admin/index.html` zmień dwie stałe:

```js
const SB_URL  = 'https://<TWÓJ-REF>.supabase.co';
const SB_ANON = '<TWÓJ-ANON-KEY>';
```

### 4. Sekrety Edge Functions

```bash
supabase login
supabase link --project-ref <REF>

supabase secrets set \
  ZADARMA_API_KEY='...' \
  ZADARMA_API_SECRET='...' \
  GEMINI_API_KEY='...' \
  DEEPSEEK_API_KEY='...' \
  SUPABASE_ANON_KEY='...'
```

| Sekret | Skąd wziąć |
|--------|-----------|
| `ZADARMA_API_KEY` | Zadarma → Mój profil → Klucze i API |
| `ZADARMA_API_SECRET` | j.w. |
| `GEMINI_API_KEY` | [aistudio.google.com](https://aistudio.google.com) → Get API Key |
| `DEEPSEEK_API_KEY` | [platform.deepseek.com](https://platform.deepseek.com) → API Keys |
| `SUPABASE_ANON_KEY` | Supabase → Project Settings → API → anon public |

### 5. Deploy

```bash
git push origin main
```

GitHub Actions automatycznie deployuje Edge Functions, wykonuje migracje i publikuje panel admina.

### 6. Supabase Auth

1. **Authentication → Users → Add user** — utwórz konto admina
2. **Authentication → Providers → Email → wyłącz "Enable sign ups"**

### 7. Zadarma webhook

Wklej URL w panelu Zadarma (lub przez support):

```
https://<REF>.supabase.co/functions/v1/zadarma-sms-webhook
```

### 8. Dodaj pierwszego użytkownika SMS

W panelu admina lub przez SQL Editor:

```sql
insert into users (code, phone_number) values ('1234', '48573311779');
```

---

## Struktura projektu

```
├── admin/                          # Panel admina (GitHub Pages)
│   ├── index.html
│   ├── favicon.ico
│   └── favicon.svg
├── supabase/
│   ├── functions/
│   │   ├── zadarma-sms-webhook/    # Odbiera SMS, odpowiada przez AI
│   │   └── admin-send-sms/         # Wysyła SMS z panelu admina
│   ├── migrations/                 # Migracje SQL
│   └── config.toml
├── scripts/
│   └── test-zadarma.ts             # Lokalny test API Zadarma
└── .github/workflows/
    ├── deploy.yml                  # Deploy Edge Functions + migracje
    └── pages.yml                   # Deploy panelu admina
```

---

## Koszty (orientacyjnie)

| Usługa | Koszt |
|--------|-------|
| Zadarma numer PL | ~20 PLN/mies. |
| SMS wychodzący | 0.18 PLN/sms |
| Supabase | Free tier |
| Gemini API | Free tier (60 req/min) |
| DeepSeek API | ~$0.001/1K tokenów |
| GitHub Pages | Darmowe |

## Technologie

- **Supabase** — PostgreSQL + Edge Functions (Deno)
- **Zadarma** — bramka SMS
- **Google Gemini** — główny model AI (fallback: DeepSeek)
- **GitHub Actions** — CI/CD
- **GitHub Pages** — panel admina (vanilla HTML/JS)
