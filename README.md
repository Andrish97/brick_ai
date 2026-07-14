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

**Odpowiedź (max 160 znaków łącznie):**
```
Odpowiedź AI (max 153 znaki)
789012
```

---

## Setup od zera

### 1. Supabase

1. Utwórz projekt na [supabase.com](https://supabase.com)
   - **Podczas tworzenia projektu ustal hasło do bazy danych** — zapisz je, będzie potrzebne w kroku 2
2. Zapisz:
   - **Project ref** — 20 znaków z URL: `supabase.com/dashboard/project/<REF>`
   - **Anon key** → Project Settings → API → sekcja "Project API keys" → klucz `anon` `public`
   - **DB connection string (pooler)** → Project Settings → Database → Connection string → Transaction pooler → wklej hasło z kroku 1

### 2. GitHub repo

1. Forkuj lub sklonuj to repo
2. **Settings → Secrets and variables → Actions → New repository secret** — dodaj:

| Sekret | Skąd wziąć |
|--------|-----------|
| `SUPABASE_ACCESS_TOKEN` | [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens) → Generate new token |
| `SUPABASE_PROJECT_REF` | 20-znakowy ref z URL projektu (np. `abcdefghijklmnopqrst`) |
| `SUPABASE_DB_URL` | Connection string z poolera, np. `postgresql://postgres.REF:[HASŁO]@aws-0-eu-west-1.pooler.supabase.com:5432/postgres` |

3. **Settings → Pages → Source: GitHub Actions** — włącza automatyczny deploy panelu admina

### 3. Zaktualizuj panel admina

W pliku `admin/index.html` zmień dwie stałe na górze bloku `<script>`:

```js
const SB_URL  = 'https://<TWÓJ-REF>.supabase.co';
const SB_ANON = '<TWÓJ-ANON-KEY>';   // Project Settings → API → anon public
```

### 4. Sekrety Edge Functions

Można ustawić **przez panel Supabase** (prościej) lub przez CLI.

**Panel:** Supabase → Edge Functions → `zadarma-sms-webhook` → Secrets → Add secret

**CLI:**
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

> Sekrety ustawione w jednym miejscu działają dla wszystkich Edge Functions w projekcie.

| Sekret | Skąd wziąć |
|--------|-----------|
| `ZADARMA_API_KEY` | Zadarma → Mój profil → Integracje i API → Klucze i API |
| `ZADARMA_API_SECRET` | j.w. |
| `GEMINI_API_KEY` | [aistudio.google.com](https://aistudio.google.com) → Get API Key |
| `DEEPSEEK_API_KEY` | [platform.deepseek.com](https://platform.deepseek.com) → API Keys |
| `SUPABASE_ANON_KEY` | Supabase → Project Settings → API → `anon` `public` |

### 5. Deploy

```bash
git push origin main
```

**Deploy jest w pełni automatyczny** — każdy push na `main` który zmienia pliki w `supabase/` lub `admin/` uruchamia GitHub Actions, który:
- Deployuje Edge Functions na Supabase
- Wykonuje nowe migracje SQL
- Publikuje panel admina na GitHub Pages

### 6. Supabase Auth

1. **Authentication → Users → Invite user** — utwórz konto admina (podaj email, użytkownik dostanie link)
2. **Authentication → Providers → Email → wyłącz "Enable sign ups"** → Save — blokuje rejestrację nowych kont

### 7. Zadarma webhook

Napisz do supportu Zadarma lub znajdź w panelu opcję webhooka SMS. Wklej URL:

```
https://<REF>.supabase.co/functions/v1/zadarma-sms-webhook
```

### 8. Dodaj pierwszego użytkownika SMS

Zaloguj się do panelu admina (`https://<TWOJ-LOGIN>.github.io/<REPO>`) → Użytkownicy → Dodaj.

Lub przez Supabase → SQL Editor:

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
