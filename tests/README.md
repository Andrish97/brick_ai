# Testy planera kolejowego

Testy lokalne nie wysyłają SMS-ów i nie łączą się z Supabase ani API PKP.

```bash
node --test tests/rail-router.test.mjs
npx deno test tests/rail-route-search.test.ts
```

Ręczny workflow GitHub Actions **Test planera kolejowego (bez SMS)** przechodzi
przez produkcyjny endpoint testowy Gemini + `plan_train_journey`. Nie uruchamia
Zadarma ani funkcji wysyłającej SMS. Domyślnie testuje tylko lokalny planer i
nie wykonuje zapytań do PKP. Opcja „Włącz awaryjne zapytania do PKP” uruchamia
pełny fallback `live` i zużywa limit API. Formularz pozwala sprawdzić źródło
`local`/`live`, liczbę wariantów, przesiadki i limit 1/3/4 części SMS.
