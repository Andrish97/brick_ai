# Brick AI — SMS Gateway

AI asystent dostępny przez SMS. Użytkownik wysyła SMS → Gemini odpowiada w 160 znakach.

## Jak to działa

```
Użytkownik → SMS → Zadarma → webhook → Supabase Edge Function → Gemini → SMS odpowiedź
```

**Format SMS — znany numer (telefon w profilu):**
```
789012        ← kod rozmowy (opcjonalny, brak = nowa rozmowa)
treść wiadomości
```

**Format SMS — nieznany numer:**
```
1234          ← kod użytkownika (4 cyfry)
789012        ← kod rozmowy (opcjonalny)
treść wiadomości
```

**Odpowiedź (max 160 znaków łącznie):**
```
Odpowiedź AI (max 153 znaki)
789012        ← kod rozmowy — użyj go w kolejnym SMS, aby kontynuować tę rozmowę
```

---

## Komendy SMS

| Komenda | Opis |
|---------|------|
| `tryb długi` / `rozwiń` / `extended on` | Włącza tryb rozszerzony dla **tej rozmowy** |
| `tryb krótki` / `extended off` | Wyłącza tryb rozszerzony |
| `dalej` / `więcej` / `next` / `kontynuuj` | Wysyła następną część długiej odpowiedzi |
| `nawigacja A > B` | Trasa turn-by-turn z A do B |
| `koniec` / `stop` / `zamknij` / `end` | Zamyka bieżącą rozmowę |

---

## Tryb rozszerzony i kontynuacja

Domyślnie AI odpowiada w jednym SMS (max 153 znaki treści). Tryb rozszerzony pozwala na odpowiedzi do ~450 znaków (3 SMS), dzielone automatycznie.

**Jak to działa:**
1. Wysyłasz `tryb długi` — system potwierdza, flaga ustawiona na tę rozmowę
2. AI dostaje instrukcję że może pisać dłużej
3. Jeśli odpowiedź nie mieści się w jednym SMS — pierwszy fragment wysłany z `...` na końcu, reszta zapamiętana
4. Piszesz `dalej` — dostajesz kolejny fragment bez angażowania AI
5. Kolejne `dalej` aż do końca odpowiedzi
6. Gdy piszesz nową wiadomość (nie `dalej`) — zapamiętana reszta jest kasowana, zaczynasz od nowa

**Tryb rozszerzony można też włączyć z panelu admina** — toggle w kolumnie "Rozszerz." w tabeli Rozmowy. Ustawienie dotyczy konkretnej rozmowy, nie użytkownika.

---

## Nawigacja

Wymaga sekretu `GOOGLE_MAPS_API_KEY` z włączonym **Routes API**.

**Format komendy:**
```
nawigacja Marszałkowska 1, Warszawa > Puławska 17, Warszawa
nawigacja dom > praca
nawigacja dom > Dworzec Centralny, Warszawa
```

Skróty `dom` i `praca` pobierane z profilu użytkownika.

**Format odpowiedzi** (Google Routes API, język polski):
```
↑ Jedź prosto ul. Marszałkowska (350m)
↰ Skręć w lewo ul. Świętokrzyska (120m)
↱ Skręć w prawo Al. Jerozolimskie (800m)
★ Puławska 17, Warszawa (2.1km, ~8min)
```

Strzałki: `↑` prosto · `↰` lewo · `↱` prawo · `↩` zawróć

**Tryby transportu** (pobierane z profilu użytkownika):

| Tryb | Routing |
|------|---------|
| Samochód | DRIVE — główne arterie |
| Rower | BICYCLE — ścieżki rowerowe |
| Pieszo | WALK — chodniki i przejścia |
| Hulajnoga | BICYCLE — ścieżki rowerowe, unika ruchliwych ulic |

Nawigacja **zawsze włącza tryb rozszerzony** i dzieli trasę na fragmenty. Pisz `dalej` po kolejne kroki.

---

## Profil użytkownika

Ustawiany w panelu admina → Użytkownicy → edycja. Dane wstrzykiwane automatycznie do kontekstu AI.

| Pole | Opis | Gdzie używane |
|------|------|---------------|
| Imię | Jak AI się zwraca do użytkownika | Każda rozmowa |
| Dom | Pełny adres z ulicą i miastem | Skrót `dom` w nawigacji, kontekst dla pogody/tras |
| Praca | Pełny adres z ulicą i miastem | Skrót `praca` w nawigacji |
| Transport | samochód / rower / pieszo / hulajnoga | Tryb routingu w nawigacji |
| Prompt | Własny system prompt (puste = globalny) | Każda rozmowa |

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
| `SETUP_SECRET` | Dowolny losowy string (np. 32 znaki) — ten sam musi być też w sekretach Edge Functions |

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
  SUPABASE_ANON_KEY='...' \
  SETUP_SECRET='...'
```

> Sekrety ustawione w jednym miejscu działają dla wszystkich Edge Functions w projekcie.

| Sekret | Skąd wziąć |
|--------|-----------|
| `ZADARMA_API_KEY` | Zadarma → Ustawienia → Integracje i API → Klucze i API → pole **Key** (wymaga potwierdzenia przez email) |
| `ZADARMA_API_SECRET` | j.w. → pole **Secret** |
| `GEMINI_API_KEY` | [aistudio.google.com](https://aistudio.google.com) → Get API Key |
| `SUPABASE_ANON_KEY` | Supabase → Project Settings → API → `anon` `public` |
| `SETUP_SECRET` | Ten sam losowy string co w GitHub Secrets — autoryzuje automatyczną konfigurację webhooka Zadarma |
| `GOOGLE_MAPS_API_KEY` | (opcjonalny) [console.cloud.google.com](https://console.cloud.google.com) → APIs & Services → Enable **Routes API** → Credentials → Create API Key — wymagany do komendy `nawigacja` |

> **Dlaczego tylko Gemini?** Gemini 2.0 Flash ma wbudowaną wyszukiwarkę Google (`googleSearch`) — jedyny darmowy model z dostępem do danych w czasie rzeczywistym (pogoda, kursy walut, aktualności) bez dodatkowych integracji.

### 5. Deploy

```bash
git push origin main
```

**Deploy jest w pełni automatyczny** — każdy push na `main` który zmienia pliki w `supabase/` lub `admin/` uruchamia GitHub Actions, który:
- Deployuje Edge Functions na Supabase
- Wykonuje nowe migracje SQL
- Publikuje panel admina na GitHub Pages

### 6. Supabase Auth

1. **Authentication → Users → Add user** — wpisz email i hasło bezpośrednio (bez wysyłania linku)
2. **Authentication → Providers → Email → wyłącz "Enable sign ups"** → Save — blokuje rejestrację nowych kont

### 7. Zadarma — rejestracja i konfiguracja webhooka

#### a) Rejestracja i weryfikacja

1. Zarejestruj się na [zadarma.com](https://zadarma.com)
2. Zweryfikuj tożsamość — wymagane dla numerów polskich (dokument tożsamości przez panel)
3. Doładuj konto (zakup numeru wymaga środków)

#### b) Zakup wirtualnego numeru

Zadarma zaproponuje podłączenie numeru już przy pierwszym logowaniu. Można to zrobić ręcznie: **Ustawienia → Numery wirtualne → Podłącz numer** → wybierz kraj i numer.

Upewnij się, że numer ma włączony **odbiór SMS** (opcja przy zakupie lub w ustawieniach numeru).

Instrukcja wideo (PL): [Jak dodać wirtualny numer w Zadarma](https://www.youtube.com/watch?v=lO4mKxmOVuU&list=PLPGEmuoHtxlJzl80Y3zy0VcXSAtDcM_2p&index=4)

#### c) Konfiguracja webhooka — automatyczna

**Webhook konfiguruje się automatycznie** przy każdym deployu (GitHub Actions wywołuje Edge Function `setup-zadarma-webhook`).

> **Wymagana Wirtualna Centrala** — API Zadarma do konfiguracji webhooka (`/v1/pbx/webhooks/`) działa tylko przy aktywnej Wirtualnej Centrali. Bez niej automatyczna konfiguracja nie zadziała i trzeba skontaktować się z supportem Zadarmy podając URL webhooka.

Działa przez API Zadarma (sekcja [Informacja o połączeniach](https://zadarma.com/pl/support/api/#intro)):
- `POST /v1/pbx/webhooks/url/` — ustawia URL webhooka
- `POST /v1/pbx/webhooks/hooks/` — włącza powiadomienia SMS

Wymagane sekrety (patrz kroki 2 i 4): `ZADARMA_API_KEY`, `ZADARMA_API_SECRET`, `SETUP_SECRET`.

> Webhook musi odpowiadać na GET z `?zd_echo=...` zwracając tę samą wartość — Edge Function już to obsługuje.

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
| Google Routes API | $5/1000 tras (200$ kredytu/mies. gratis ≈ 40 000 tras) |
| GitHub Pages | Darmowe |

## Technologie

- **Supabase** — PostgreSQL + Edge Functions (Deno)
- **Zadarma** — bramka SMS
- **Google Gemini 2.0 Flash** — model AI z wbudowaną wyszukiwarką Google (dane w czasie rzeczywistym)
- **Google Routes API** — precyzyjna nawigacja turn-by-turn (opcjonalna)
- **GitHub Actions** — CI/CD
- **GitHub Pages** — panel admina (vanilla HTML/JS)
