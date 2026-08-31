-- Realny dowód z produkcji: Katowice (gęsty węzeł metropolitalny, GOP) generuje ponad 200
-- ODRĘBNYCH (godzina, cel) par w niecałe 5 godzin przed świtem — LIMIT 200 z poprzedniej
-- migracji wyczerpywał się, zanim dotarł nawet do połowy przeszukiwanego 12-godzinnego
-- okna, więc diagnostyka nigdy nie zobaczyła realnego porannego kursu (np. 07:20). Przy
-- obserwowanej gęstości (~40-45/h) cały dzień to rząd 500-550 odrębnych par — 1000 daje
-- bezpieczny zapas.
create or replace function public.rail_debug_departures(
  p_stop_ids uuid[], p_date date, p_dep_from int, p_dep_to int
) returns table (
  dep_seconds int, to_stop_id uuid, distinct_service_variants bigint, any_active_today boolean
) as $$
  select
    c.dep_seconds, c.to_stop_id, count(distinct c.service_id) as distinct_service_variants,
    bool_or(
      exists (
        select 1 from public.rail_calendar_dates cd
        where cd.service_id = c.service_id and cd.date = p_date and cd.exception_type = 1
      )
      or (
        exists (
          select 1 from public.rail_calendar cal
          where cal.id = c.service_id
            and cal.start_date <= p_date and cal.end_date >= p_date
            and (
              (extract(dow from p_date)::int = 0 and cal.sunday) or
              (extract(dow from p_date)::int = 1 and cal.monday) or
              (extract(dow from p_date)::int = 2 and cal.tuesday) or
              (extract(dow from p_date)::int = 3 and cal.wednesday) or
              (extract(dow from p_date)::int = 4 and cal.thursday) or
              (extract(dow from p_date)::int = 5 and cal.friday) or
              (extract(dow from p_date)::int = 6 and cal.saturday)
            )
        )
        and not exists (
          select 1 from public.rail_calendar_dates cd2
          where cd2.service_id = c.service_id and cd2.date = p_date and cd2.exception_type = 2
        )
      )
    ) as any_active_today
  from public.rail_connections c
  where c.from_stop_id = any(p_stop_ids)
    and c.dep_seconds >= p_dep_from and c.dep_seconds < p_dep_to
  group by c.dep_seconds, c.to_stop_id
  order by c.dep_seconds
  limit 1000;
$$ language sql stable;
