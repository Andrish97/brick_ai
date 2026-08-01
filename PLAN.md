# Plan: rozmowa naturalnym językiem i nawigacja przez endpointy

## Cel

Użytkownik SMS nie wpisuje komend technicznych. Model rozpoznaje intencję w zwykłej wypowiedzi i, gdy jest to konieczne, wywołuje kontrolowane endpointy aplikacji.

Zakres obejmuje:

- dłuższe odpowiedzi po wyraźnej zgodzie użytkownika;
- definitywne zamykanie rozmowy;
- nawigację Google Directions API;
- komunikację miejską przez tryb `transit` Google Directions API;
- fundament integracji oficjalnego API Otwarte Dane Kolejowe PKP PLK;
- aktualizację README w tym samym wdrożeniu.

Kolej obejmuje dane planowe, bieżącą realizację, opóźnienia, utrudnienia oraz własny planer połączeń kolejowych z przesiadkami. API PLK nie udostępnia pojedynczego endpointu „znajdź najszybsze połączenie”, więc aplikacja zbuduje plan podróży nad jego danymi rozkładowymi.

## Stan obecny

`supabase/functions/zadarma-sms-webhook/index.ts` obsługuje całą logikę w jednym webhooku. Rozpoznaje techniczne komendy `->`, `<-`, `-->` i `nav A > B`, przechowuje pozostałą część odpowiedzi w `pending_reply` oraz używa Google Routes API. Format nawigacji korzysta obecnie z Unicode i nie spełnia nowego formatu SMS.

`README.md` dokumentuje te komendy, Routes API i konieczność proszenia o kolejne części trasy. Będzie wymagał aktualizacji równolegle z kodem.

## Architektura endpointów

1. Dodać prywatzną Supabase Edge Function `assistant-tools`.
2. Główny webhook wywołuje ją wyłącznie serwerowo, z uwierzytelnieniem opartym o sekret. Nie będzie publicznym interfejsem dla numerów SMS ani modelem otrzymującym sekrety.
3. Gemini otrzymuje deklaracje funkcji. Gdy rozpozna odpowiednią intencję, zwraca nazwę funkcji i walidowane argumenty.
4. Webhook waliduje wywołanie, uruchamia `assistant-tools`, zapisuje wynik w logu i przekazuje rezultat modelowi lub wysyła gotowy wynik bezpośrednio, jeśli jest to deterministyczna trasa.
5. Model nigdy nie tworzy formatu nawigacji. Formatowanie wykonuje endpoint, aby zachować jednolitość i bezpieczeństwo.

Pierwszy zestaw akcji endpointu:

| Akcja | Argumenty | Efekt |
|---|---|---|
| `allow_long_reply` | `parts`: `3` lub `4` | Ustawia limit odpowiedzi dla rozmowy. |
| `close_conversation` | `conversation_id` | Definitywnie zamyka daną rozmowę. |
| `get_user_profile` | opcjonalna lista pól | Zwraca wyłącznie potrzebne dane profilu bieżącego użytkownika. |
| `get_directions` | początek, cel, transport | Pobiera i formatuje pełną trasę. |
| `get_transit` | początek, cel, czas wyjazdu | Pobiera trasę transportem miejskim i jej szczegóły. |
| `get_fastest_arrival` | początek, cel, czas wyjścia, opcje transportu | Porównuje czasy tras i zwraca najwcześniejsze dotarcie. |
| `get_train_station_board` | stacja, data, przewoźnicy | Pobiera planowe odjazdy/przyjazdy ze stacji PKP PLK. |
| `get_train_status` | identyfikator pociągu, data kursowania | Pobiera rzeczywiste wykonanie, opóźnienie i status pociągu PKP PLK. |
| `get_train_disruptions` | stacje lub zakres dat | Pobiera utrudnienia ruchu kolejowego PKP PLK. |
| `plan_train_journey` | początek, cel, czas wyjazdu/przyjazdu, preferencje | Wyszukuje najszybszą podróż pociągiem, również z przesiadkami. |

## Naturalne intencje

Usunąć wymóg wpisywania komend SMS. Przykłady oczekiwanego działania:

| Wypowiedź użytkownika | Akcja |
|---|---|
| „możesz odpisać szerzej” | `allow_long_reply(parts: 3)` |
| „możesz pisać w czterech SMS-ach” | `allow_long_reply(parts: 4)` |
| „kontynuuj” / „możesz kontynuować” | `allow_long_reply`, tylko gdy sens wypowiedzi jest zgodą na dłuższą odpowiedź |
| „to koniec”, „żegnam się”, „nie kontynuuj” | `close_conversation` |
| „poprowadź mnie z domu do pracy rowerem” | `get_directions` |
| „jak dojadę tramwajem do rynku?” | `get_transit` |

Deklaracje funkcji mają zawierać precyzyjny opis, wymagane argumenty oraz enumerację trybów transportu. Model nie może wywołać akcji zamknięcia wyłącznie dlatego, że w tekście wystąpiło słowo podobne do „koniec”; musi rozpoznać realną intencję zakończenia.

Dotychczasowe komendy nie będą już dokumentowane ani potrzebne do normalnej obsługi. Decyzja implementacyjna: zachować je przejściowo jako niedokumentowaną zgodność wsteczną albo usunąć je całkowicie po wdrożeniu endpointów.

## Dane profilu użytkownika

Obecnie webhook dopisuje imię, dom, pracę i preferowany transport do każdego system promptu. Zastąpić to narzędziem `get_user_profile`, aby model pobierał wyłącznie pola niezbędne do aktualnej odpowiedzi.

1. System prompt informuje jedynie, że narzędzie jest dostępne i kiedy należy go użyć; nie zawiera domyślnie adresów ani innych danych profilu.
2. Endpoint działa w kontekście uwierzytelnionego `user_id` bieżącej rozmowy. Model nie przekazuje identyfikatora użytkownika i nie może odczytać cudzego profilu.
3. Argument `fields` jest listą dozwolonych wartości: `name`, `home`, `work`, `transport`.
4. Endpoint zwraca wyłącznie zażądane pola, z pominięciem pustych wartości.
5. Endpointy tras oraz `get_fastest_arrival` powinny samodzielnie rozwijać techniczne wartości `home` i `work` na adresy z bazy. W zwykłym przypadku model nie musi więc otrzymywać adresu domu lub pracy.
6. Przykład: „o której najszybciej będę w pracy, jeśli teraz wyjdę z domu?” powoduje wywołanie `get_fastest_arrival(origin: "home", destination: "work", departure_time: "now")`. Endpoint odczytuje profil serwerowo, porównuje dozwolone środki transportu i zwraca gotowy wynik.
7. `get_user_profile` jest potrzebne tylko wtedy, gdy odpowiedź rzeczywiście wymaga danych profilu, np. imienia lub potwierdzenia ustawionego transportu.

To ogranicza długość promptów, ekspozycję danych osobowych oraz liczbę miejsc, w których adresy muszą być obsługiwane.

## Fundament API PKP PLK

Oficjalne API Otwarte Dane Kolejowe PKP PLK zostanie podłączone jako niezależne źródło danych kolejowych. Sekret `PKP_API_KEY` jest już zapisany w Supabase Edge Function Secrets i może być odczytywany wyłącznie przez funkcje serwerowe.

1. Dodać do `assistant-tools` adapter PKP PLK z bazowym URL `https://pdp-api.plk-sa.pl/api/v1`.
2. Każde żądanie API wysyła nagłówek `X-API-Key: <PKP_API_KEY>`; klucz nie może trafić do SMS-a, promptu Gemini, logów ani panelu administracyjnego.
3. Dodać wyszukanie stacji przez `/dictionaries/stations?search=...` i jednoznaczne mapowanie nazwy stacji na identyfikator PKP PLK. Przy wielu pasujących stacjach AI dopytuje użytkownika, zamiast wybierać przypadkową.
4. Dodać odczyt rozkładu planowego dla stacji przez `/schedules` z parametrami daty i identyfikatora stacji.
5. Dodać odczyt realizacji w czasie rzeczywistym przez `/operations` z `withPlanned=true`, aby zwracać planowy czas oraz opóźnienie.
6. Dodać odczyt utrudnień przez `/disruptions` oraz szczegółowej trasy znanego pociągu przez endpoint trasy dostępny w API PLK.
7. Wprowadzić limity, cache dla słownika stacji oraz obsługę kodów `401`, `403`, `429` i `5xx`. Brak danych lub limit API ma skutkować krótką, uczciwą odpowiedzią SMS, a nie zgadywaniem.
8. Logować wyłącznie metadane żądania — typ endpointu, status HTTP, czas odpowiedzi i ewentualny `traceId` — bez klucza i bez pełnych danych użytkownika.
9. Zaimplementować `plan_train_journey` jako planer nad danymi PLK. Przyjmuje stację początkową, końcową, czas „wyjazd po” albo „przyjazd przed” oraz opcjonalnie maksymalną liczbę przesiadek.
10. Z danych planowych zbudować graf przejazdów: każdy postój pociągu jest węzłem czasowym, a kolejne postoje tego samego pociągu są krawędziami przejazdu. Przesiadka jest możliwa wyłącznie na tej samej stacji po minimalnym czasie technicznym.
11. W pierwszej wersji zastosować algorytm earliest-arrival (połączenia przetwarzane chronologicznie): wybiera najwcześniejszy możliwy przyjazd, obsługuje połączenia bezpośrednie i przesiadki, nie zakładając stałej liczby segmentów.
12. Ustawić bezpieczne ograniczenia: domyślnie maksymalnie 3 przesiadki, minimalny czas przesiadki 10 minut, okno wyszukiwania 24 godziny i limit liczby zwracanych wariantów. Parametry muszą być konfigurowalne.
13. Dla kandydatów najlepszego planu dociągnąć dane `/operations` i skorygować planowane czasy o dostępne opóźnienia, odwołania oraz utrudnienia. Jeśli dane real-time są niepełne, odpowiedź wyraźnie oznacza czas jako planowy.
14. Cache'ować słownik stacji i dane rozkładu według daty; nie pobierać całego krajowego rozkładu dla każdego SMS-a. Cache ma wygasać po zmianie wersji danych PLK i po końcu dnia rozkładowego.
15. W razie braku trasy, zbyt wielu dopasowań stacji albo przekroczonych limitów API endpoint zwraca ustrukturyzowaną przyczynę, a AI zadaje jedno konkretne pytanie lub informuje o braku połączenia.

Format wyniku `plan_train_journey` dla SMS-a powinien być zwięzły i deterministyczny, na przykład:

```text
Katowice 12:14 -> Krakow Gl. 13:05
IC 63100, bez przesiadek, planowo 51 min
```

Dla przesiadki:

```text
Katowice 12:14 -> Gliwice 12:38 KS 407
Gliwice 12:49 -> Wroclaw Gl. 14:31 IC 56
1 przesiadka, planowo 2h17
```

Przykładowe przyszłe zapytania:

- „Kiedy najbliższy pociąg z Katowic?” -> wyszukanie stacji + rozkład planowy/realizacja.
- „Czy IC 8312 ma opóźnienie?” -> wykonanie konkretnego pociągu.
- „Czy są utrudnienia między Katowicami a Krakowem?” -> utrudnienia dla wskazanych stacji.
- „Jak najszybciej dojadę pociągiem z Katowic do Wrocławia, jeśli wyjadę teraz?” -> `plan_train_journey` z bieżącym czasem wyjazdu.

## README: sekret PKP

W tym samym wdrożeniu uzupełnić `README.md` o:

1. sekret Edge Function `PKP_API_KEY`;
2. informację, że jest to klucz oficjalnego API Otwarte Dane Kolejowe PKP PLK;
3. zakres danych: planowy rozkład, realizacja, opóźnienia i utrudnienia;
4. opis wyszukiwania tras kolejowych z przesiadkami oraz jego ograniczeń: okno czasu, minimalny czas przesiadki i liczba przesiadek;
5. zasadę bezpiecznego przechowywania sekretu wyłącznie po stronie Supabase;
6. odpowiednią pozycję w strukturze endpointów oraz w sekcji technologii.

## Dłuższe odpowiedzi

1. Dodać migrację rozszerzającą `conversations` o `reply_sms_parts`.
2. Dopuszczalne wartości: `1`, `3`, `4`; wartość domyślna: `1`.
3. `extended_mode` zachować na czas migracji zgodności, a potem przestać używać go jako źródła prawdy.
4. Po wyraźnej zgodzie `allow_long_reply` zapisuje `3` albo `4` dla bieżącej rozmowy.
5. Generator Gemini dostaje limit tokenów wyliczony dla danego limitu SMS, a system prompt jasno określa maksymalną długość odpowiedzi.
6. Odpowiedź w limicie ma zostać od razu podzielona i wysłana we wszystkich dozwolonych SMS-ach. Użytkownik nie wpisuje `-->` po kolejne fragmenty.
7. Gdy odpowiedź przekroczy limit, endpoint bezpiecznie skraca ją na granicy zdania lub słowa, zapisuje zdarzenie w logu i nie wysyła nieograniczonej liczby SMS-ów.
8. `pending_reply` nie będzie elementem nowego normalnego przepływu. Nie należy usuwać kolumny w tej zmianie, aby nie wykonywać niepotrzebnej destrukcyjnej migracji.

## Zamykanie rozmowy

1. `close_conversation` zmienia status bieżącej rozmowy na `closed`.
2. Czyści `pending_reply` i zapisuje w logu źródłową intencję oraz czas.
3. Kolejny SMS zawierający kod zamkniętej rozmowy nie może jej reaktywować.
4. Brak kodu nadal może utworzyć nową rozmowę dla tego samego użytkownika, o ile nie zostanie podjęta odrębna decyzja o globalnej blokadzie numeru.
5. Endpoint powinien zwrócić krótkie, opcjonalne potwierdzenie, mieszczące się w jednym SMS-ie, albo zakończyć bez odpowiedzi — tę decyzję należy ustalić przed implementacją UX.

## Google Directions API

Zastąpić obecne wywołanie Routes API żądaniem do Google Directions API. Jest to wymagane do otrzymania pól `maneuver` i `html_instructions`, a API obsługuje `driving`, `walking`, `bicycling` i `transit`.

Mapowanie profilu użytkownika:

| Profil | `mode` Google |
|---|---|
| pieszo | `walking` |
| samochód | `driving` |
| rower | `bicycling` |
| hulajnoga | `bicycling` |
| komunikacja miejska | `transit` |

Hulajnoga zawsze używa `bicycling`, bez rozróżniania miasta i trasy pozamiejskiej. Adresy „dom” oraz „praca” są rozwijane przez serwer z profilu użytkownika. Jeżeli brakuje któregoś z adresów, model dostaje błąd endpointu i prosi krótko o brakującą wartość, bez zgadywania.

## Format nawigacji ASCII

Endpoint formatuje każdy krok w postaci:

```text
symbol dystans nazwa_ulicy
```

Przykład:

```text
< 300m Chorzowska
^ 850m Aleja Roździeńskiego
O2 120m ul. Katowicka
* 0m Cel
```

Zasady:

1. Symbol wynika wyłącznie z pola `maneuver`; nie wolno wyciągać kierunku z polskiej treści instrukcji.
2. Dystans pochodzi z liczbowego pola `distance.value`, jest zaokrąglony do metrów i zawsze ma postać np. `1250m`, bez kilometrowego skrótu.
3. Symbole są ASCII. Nazwy własne ulic mogą zachować polskie znaki.
4. Nie pomijać krótkich kroków: wynik ma zawierać całą trasę.
5. Ostatnia linia ma zawsze postać `* 0m <cel>`.
6. Cały gotowy tekst trasy jest wysyłany od razu, niezależnie od liczby SMS-ów. Limit 3/4 SMS-ów dotyczy odpowiedzi modelu, nie pełnej trasy nawigacyjnej.

Tabela mapowania:

| `maneuver` | Symbol |
|---|---|
| `straight` | `^` |
| `turn-left` | `<` |
| `turn-right` | `>` |
| `turn-slight-left`, `keep-left` | `<^` |
| `turn-slight-right`, `keep-right` | `>^` |
| `turn-sharp-left` | `<<` |
| `turn-sharp-right` | `>>` |
| `uturn-left`, `uturn-right` | `<>` |
| `roundabout-left`, `roundabout-right` | `O<numer zjazdu>` |
| `merge` lub zmiana drogi bez skrętu | `|` |
| brak manewru lub łagodny łuk | `~` |

### Nazwa ulicy z `html_instructions`

Google nie zwraca odrębnego pola nazwy ulicy w kroku Directions API. Wymaganie użycia `html_instructions` zostanie zrealizowane bez językowego parsowania polskiej instrukcji: serwer pobierze oznaczony przez Google fragment nazwy drogi, usunie wyłącznie HTML i zachowa tekst bez skracania, tłumaczenia lub zmiany. Gdy API nie oznaczy nazwy drogi, endpoint użyje oczyszczonej instrukcji i zapisze ostrzeżenie w logu.

To wymaga akceptacji ryzyka: dokumentacja Google traktuje `html_instructions` jako treść prezentacyjną i zaleca nie parsować jej programowo. Nie istnieje jednak osobne pole ulicy spełniające wskazane wymaganie.

## Komunikacja miejska

`get_transit` korzysta z Directions API z `mode=transit` i bieżącym czasem wyjazdu, chyba że użytkownik poda inny.

Endpoint ma zwrócić całą podróż, w tym:

- dojście pieszo do przystanku i z przystanku;
- linię i jej kierunek;
- przystanek wejścia i wyjścia;
- planowany odjazd oraz przyjazd;
- czas przejazdu;
- wszystkie przesiadki.

Odcinki piesze przechodzą przez standardowy formatter manewrów. Przejazd linią wymaga ustalonego formatu tekstowego, np.:

```text
| 0m 4 Dworzec -> Rynek 12:03-12:19
```

Należy zatwierdzić ten format lub wskazać alternatywę, ponieważ obecna tablica symboli opisuje manewry drogowe, a nie przejazd autobusem, tramwajem lub metrem.

## Zmiany w README

W tym samym zestawie zmian zaktualizować `README.md`:

1. Usunąć sekcję „Komendy SMS”.
2. Opisać naturalny język, zgodę na 3/4 SMS-y i przesyłanie wszystkich części bez `-->`.
3. Opisać definitywne zamknięcie rozmowy.
4. Opisać endpointy/narzędzia i ich granice bezpieczeństwa.
5. Zastąpić Routes API przez Google Directions API w instrukcji sekretów, wymaganiach, kosztach i liście technologii.
6. Dodać pełny format ASCII oraz tabelę symboli.
7. Dodać działanie transportu miejskiego.
8. Nie umieszczać integracji PKP PLK w dokumentacji tej wersji.

## Testy i odbiór

Przed wdrożeniem przygotować testy z atrapami Gemini, Google i Zadarma:

1. Zgoda na 3 oraz 4 SMS-y.
2. Brak zgody: odpowiedź ograniczona do 1 SMS-a.
3. Wysłanie wszystkich dozwolonych części bez komendy kontynuacji.
4. Zamknięcie rozmowy i brak reaktywacji po podaniu jej kodu.
5. Wszystkie wpisy z tabeli manewrów, w tym rondo i zawracanie.
6. Dystanse poniżej i powyżej kilometra, zawsze w metrach.
7. Nazwa ulicy z `html_instructions`, brak oznaczonej ulicy oraz znaki diakrytyczne.
8. Pieszo, samochód, rower, hulajnoga i komunikacja miejska.
9. Trasa dłuższa niż jeden, trzy lub cztery SMS-y: zawsze cała i od razu wysłana.
10. Brak klucza Google, niepoprawny adres, brak adresu domu/pracy i brak trasy.
11. Zachowanie obecnego rozpoznawania użytkownika, kodów rozmów, logowania i ochrony przed duplikatem webhooka.
12. PKP PLK: jednoznaczne i niejednoznaczne stacje, przejazd bezpośredni, jedna i wiele przesiadek, minimalny czas przesiadki, brak połączenia, anulowanie, opóźnienie i przekroczony limit API.
13. PKP PLK: wybór trasy o najwcześniejszym przyjeździe dla czasu „wyjazd po” oraz wybór wariantu spełniającego „przyjazd przed”.

## Kolejność realizacji

1. Dodać migrację i kontrakt endpointu `assistant-tools`.
2. Dodać `get_user_profile` oraz serwerowe rozwijanie `home`/`work` w endpointach tras.
3. Zaimplementować function calling Gemini oraz walidację akcji w webhooku.
4. Zaimplementować długie odpowiedzi i zamykanie rozmowy.
5. Zastąpić integrację tras Directions API oraz formatter ASCII.
6. Dodać `get_fastest_arrival`, `transit` i zatwierdzony format odcinków komunikacji miejskiej.
7. Dodać adapter PKP PLK, wyszukiwanie stacji, dane planowe, realizację, utrudnienia oraz `plan_train_journey` z przesiadkami.
8. Usunąć lub zdeprecjonować starą logikę komend i `pending_reply`.
9. Zaktualizować README, w tym `PKP_API_KEY`, działanie planera kolejowego i ograniczenia źródeł danych.
10. Uruchomić testy, sprawdzenie formatowania i próbne webhooki.
11. Wdrożyć dopiero po pozytywnym odbiorze scenariuszy SMS.
