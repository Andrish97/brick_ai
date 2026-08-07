# Brick AI — SMS Gateway

AI asystent dostępny przez SMS. Użytkownik pisze zwykłym językiem — Gemini rozpoznaje intencję i, gdy trzeba, wywołuje kontrolowane endpointy aplikacji (nawigacja, dłuższa odpowiedź, zamknięcie rozmowy).

## Jak to działa

```
Użytkownik → SMS → Zadarma → webhook → Gemini (function calling) → assistant-tools → SMS odpowiedź
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

## Naturalny język — bez komend

Nie ma już technicznych komend do zapamiętania. Piszesz zwykłym zdaniem, a model sam rozpoznaje intencję i w razie potrzeby wywołuje odpowiedni endpoint:

| Wypowiedź | Co się dzieje |
|---|---|
| „możesz odpisać szerzej” / „pisz w czterech SMS-ach” | AI włącza dłuższą odpowiedź dla tej rozmowy (patrz niżej) |
| „to koniec”, „żegnam się”, „nie kontynuuj” | AI definitywnie zamyka rozmowę |
| „poprowadź mnie z domu do pracy rowerem” | AI pobiera trasę krok po kroku |
| „jak dojadę tramwajem do rynku?” | AI pobiera trasę komunikacją miejską |
| „o której najszybciej będę w pracy?” | AI porównuje dostępne środki transportu |

Model nigdy nie zgaduje — jeśli intencja nie jest jednoznaczna (np. słowo „koniec” użyte w innym sensie), zwyczajnie odpowiada dalej w rozmowie zamiast wywoływać narzędzie.

Słowa `koniec` / `stop` / `zamknij` / `end` jako **jedyna** treść SMS-a nadal działają jako szybka, deterministyczna ścieżka zamknięcia rozmowy (bez angażowania modelu).

---

## Dłuższe odpowiedzi

Domyślnie AI odpowiada w jednym SMS (max 153 znaki treści). Gdy wyraźnie zgodzisz się na dłuższą odpowiedź, model włącza limit **3 lub 4 SMS-y** dla tej rozmowy — i wysyła od razu wszystkie części w jednej odpowiedzi, bez konieczności pisania czegokolwiek po kolejne fragmenty.

Rzeczywisty przyznany limit nigdy nie przekracza globalnego ustawienia (panel admina → Ustawienia → „Limit SMS-ów odpowiedzi rozszerzonej (1, 3 lub 4)”, domyślnie 4) — to jeden wspólny limit dla wszystkich użytkowników, a nie ustawienie per profil. To jest twardy limit kosztu — jeśli poprosisz o 4 SMS-y, a globalny limit to 3, dostaniesz 3.

Limit dotyczy pojedynczej rozmowy i obowiązuje aż do jej zamknięcia lub aż poprosisz o inną liczbę części.

---

## Zamykanie rozmowy

Gdy AI rozpozna wyraźną intencję zakończenia rozmowy, zamyka ją definitywnie — bez dodatkowego potwierdzenia SMS-em (oszczędza SMS-a; kolejny SMS z kodem zamkniętej rozmowy po prostu zakłada nową rozmowę zamiast reaktywować starą).

---

## Nawigacja

Wymaga sekretu `GOOGLE_MAPS_API_KEY` z włączonym **Directions API**.

Nie ma już komendy `nav` — poproś zwykłym zdaniem, np. „jak dojdę z domu do pracy?”, „poprowadź mnie rowerem na dworzec”. Skróty „dom” i „praca” są rozwijane po stronie serwera z profilu użytkownika — adres nigdy nie trafia do modelu.

**Obsługiwane środki transportu:** pieszo, rower, hulajnoga, komunikacja miejska. **Samochód nie jest obsługiwany** — celowo, aby trasa zawsze mieściła się w rozsądnej liczbie SMS-ów.

**Format odpowiedzi** — jedna linia na krok, ASCII:

```
< 300m Chorzowska
^ 850m Aleja Roździeńskiego
O2 120m ul. Katowicka
* 0m Cel
```

| Symbol | Manewr |
|---|---|
| `^` | prosto |
| `<` / `>` | skręć w lewo / prawo |
| `<^` / `>^` | lekko w lewo / prawo |
| `<<` / `>>` | ostro w lewo / prawo |
| `<>` | zawróć |
| `O<numer>` | rondo, wskazany zjazd |
| `\|` | zmiana drogi bez skrętu |
| `~` | brak manewru / łagodny łuk |

Dystans zawsze w metrach, zaokrąglony (np. `1250m`). Ostatnia linia to zawsze `* 0m <cel>`. Nazwa ulicy pochodzi z pogrubionego przez Google fragmentu instrukcji (`html_instructions`) — bez tłumaczenia ani skracania.

**Limit długości trasy:** maksymalnie **6 SMS-ów**. Jeśli trasa jest dłuższa, AI odpowiada krótką informacją, że trasa jest zbyt długa na SMS, zamiast wysyłać oszukańczo obciętą (i przez to potencjalnie mylącą) nawigację.

---

## Komunikacja miejska

Poproś np. „jak dojadę tramwajem do rynku?” — AI pobiera całą podróż: dojście pieszo do przystanku, linię i kierunek, przystanek wejścia/wyjścia, godziny odjazdu/przyjazdu oraz przesiadki, licząc od bieżącego czasu.

Odcinki piesze używają tego samego formatu co nawigacja. Odcinek linią:

```
| 0m 4 Dworzec -> Rynek 12:03-12:19
```

---

## Profil użytkownika

Ustawiany w panelu admina → Użytkownicy → edycja. Model **nie** dostaje tych danych automatycznie w każdej rozmowie — pobiera tylko to, czego faktycznie potrzebuje, przez narzędzie `get_user_profile` (np. imię), albo adres jest rozwijany po stronie serwera bez udziału modelu (nawigacja).

| Pole | Opis | Gdzie używane |
|------|------|---------------|
| Imię | Jak AI się zwraca do użytkownika | Na żądanie, przez `get_user_profile` |
| Dom | Pełny adres z ulicą i miastem | Skrót „dom” w nawigacji — rozwijany serwerowo |
| Praca | Pełny adres z ulicą i miastem | Skrót „praca” w nawigacji — rozwijany serwerowo |
| Transport | pieszo / rower / hulajnoga / komunikacja miejska | Domyślny tryb routingu w nawigacji |
| Prompt | Własny system prompt (puste = globalny) | Każda rozmowa |

Limit SMS-ów odpowiedzi rozszerzonej **nie** jest polem profilu — to jedno globalne ustawienie dla wszystkich użytkowników (panel admina → Ustawienia → „Limit SMS-ów odpowiedzi rozszerzonej”, domyślnie 4).

---

## Endpointy / narzędzia

Cała logika komend żyje w prywatnej Edge Function `assistant-tools`, wywoływanej wyłącznie serwerowo przez `zadarma-sms-webhook` (uwierzytelnienie nagłówkiem `X-Internal-Secret`). Nie jest to publiczny interfejs — SMS-y nigdy nie trafiają do niej bezpośrednio, a model nigdy nie otrzymuje sekretów.

| Narzędzie | Argumenty | Efekt |
|---|---|---|
| `allow_long_reply` | `parts`: 3 lub 4 | Ustawia limit SMS-ów odpowiedzi dla rozmowy, ograniczony globalnym ustawieniem |
| `close_conversation` | — | Definitywnie zamyka bieżącą rozmowę |
| `get_user_profile` | opcjonalna lista pól | Zwraca wyłącznie zażądane pola profilu bieżącego użytkownika |
| `get_directions` | start, cel, opcjonalny transport | Pobiera i formatuje trasę krok po kroku |
| `get_transit` | start, cel | Pobiera trasę komunikacją miejską z przesiadkami |
| `get_fastest_arrival` | start, cel | Porównuje dostępne środki transportu i zwraca najszybszy |

Wyniki nawigacji i komunikacji miejskiej formatuje wyłącznie endpoint — model nigdy nie tworzy własnego formatu trasy, co gwarantuje spójność i bezpieczeństwo (żadnych zmyślonych ulic czy odległości).

### Logowanie

`assistant-tools` i `zadarma-sms-webhook` zapisują zdarzenia do wspólnej tabeli `logs`, widocznej w panelu admina → Logi. Wywołanie narzędzia i jego wynik (`Narzędzie` / `Wynik narzędzia`) są widoczne od strony webhooka; błędy Google Directions (`Directions błąd`) i nieobsłużone wyjątki (`Endpoint błąd`) są logowane od strony samego `assistant-tools`, więc nie trzeba zaglądać do surowej konsoli Deno, żeby zdiagnozować problem.

### Testowanie bez wysyłania SMS-ów

Doklej `?dry_run=1` do URL-a `zadarma-sms-webhook` — cała logika (Gemini, function calling, wywołania narzędzi) działa normalnie, ale zamiast SMS-a webhook zwraca treść odpowiedzi jako JSON. Zero kosztu SMS (Gemini i Google Maps są nadal wywoływane naprawdę, w ramach darmowych limitów).

```bash
deno run --allow-net scripts/test-endpoints.ts <SUPABASE_URL> <KOD_UZYTKOWNIKA>
```

Skrypt przepuszcza po kolei zdania wyzwalające każde narzędzie (nawigację, transit, dłuższą odpowiedź, zamknięcie rozmowy, profil) i drukuje surową odpowiedź JSON każdego z nich. Wymaga prawdziwego kodu użytkownika z bazy; dla nawigacji ten użytkownik musi mieć ustawiony adres domu i pracy w panelu.

Ten sam zestaw testów jest też dostępny bez terminala — panel admina → **Testy → 🔌 Test endpointów**. Wybierz użytkownika testowego i kliknij „Uruchom wszystkie testy” — panel woła webhook z `dry_run=1` bezpośrednio z przeglądarki (ma normalny dostęp do Twojego Supabase, więc działa nawet tam, gdzie lokalny `deno`/sieć nie sięgają) i pokazuje wynik każdego scenariusza.

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
  SETUP_SECRET='...' \
  ASSISTANT_TOOLS_SECRET='...'
```

> Sekrety ustawione w jednym miejscu działają dla wszystkich Edge Functions w projekcie.

| Sekret | Skąd wziąć |
|--------|-----------|
| `ZADARMA_API_KEY` | Zadarma → Ustawienia → Integracje i API → Klucze i API → pole **Key** (wymaga potwierdzenia przez email) |
| `ZADARMA_API_SECRET` | j.w. → pole **Secret** |
| `GEMINI_API_KEY` | [aistudio.google.com](https://aistudio.google.com) → Get API Key |
| `SUPABASE_ANON_KEY` | Supabase → Project Settings → API → `anon` `public` |
| `SETUP_SECRET` | Ten sam losowy string co w GitHub Secrets — autoryzuje automatyczną konfigurację webhooka Zadarma |
| `ASSISTANT_TOOLS_SECRET` | Dowolny losowy string — autoryzuje wywołania webhooka do `assistant-tools`. Jeśli pominięty, funkcja spada na `SUPABASE_SERVICE_ROLE_KEY`. |
| `GOOGLE_MAPS_API_KEY` | (opcjonalny) [console.cloud.google.com](https://console.cloud.google.com) → APIs & Services → Enable **Directions API** → Credentials → Create API Key — wymagany do nawigacji i komunikacji miejskiej |

> **Dlaczego tylko Gemini?** Gemini ma wbudowaną wyszukiwarkę Google (`googleSearch`) — jedyny darmowy model z dostępem do danych w czasie rzeczywistym (pogoda, kursy walut, aktualności) bez dodatkowych integracji.

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
│   │   ├── zadarma-sms-webhook/    # Odbiera SMS, rozpoznaje intencję, wysyła odpowiedź
│   │   ├── assistant-tools/        # Prywatne narzędzia wywoływane przez webhook (nigdy publicznie)
│   │   └── admin-send-sms/         # Wysyła SMS z panelu admina
│   ├── migrations/                 # Migracje SQL
│   └── config.toml
├── scripts/
│   ├── test-zadarma.ts             # Lokalny test API Zadarma
│   └── test-endpoints.ts           # Testuje wszystkie narzędzia asystenta przez dry_run — bez SMS-ów
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
| Google Directions API | $5/1000 tras (200$ kredytu/mies. gratis ≈ 40 000 tras) |
| GitHub Pages | Darmowe |

Odpowiedzi domyślnie mieszczą się w 1 SMS-ie; dłuższe odpowiedzi (3–4 SMS-y) wymagają wyraźnej zgody użytkownika i są dodatkowo ograniczone limitem profilu. Trasy nawigacyjne mają twardy limit 6 SMS-ów za zapytanie — dłuższe trasy są odrzucane zamiast wysyłane w całości.

## Technologie

- **Supabase** — PostgreSQL + Edge Functions (Deno)
- **Zadarma** — bramka SMS
- **Google Gemini** — model AI z wbudowaną wyszukiwarką Google i function calling
- **Google Directions API** — nawigacja turn-by-turn i komunikacja miejska (opcjonalna)
- **GitHub Actions** — CI/CD
- **GitHub Pages** — panel admina (vanilla HTML/JS)
