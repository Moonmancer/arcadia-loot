-- Rest-Aufteilung pro Eintrag: jeder Drop (Zeile der Storage-Liste) geht komplett an einen Teilnehmer.
-- 10 Lava gehen also an eine Person; zwei Einträge Frigg's Circlet können an zwei verschiedene gehen.
-- Verteilt wird reihum in zufälliger Reihenfolge, damit niemand mehr als einen Eintrag mehr bekommt.

create or replace function public.split_rest(p_run bigint, p_drops bigint[])
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_count integer;
begin
  if not public.is_party_seller(public.run_party(p_run)) then
    raise exception 'Nur Admins und Verkäufer können Rest aufteilen';
  end if;
  if (select status from public.runs where id = p_run) <> 'verkauf' then
    raise exception 'Rest wird in der Phase „Verkauf“ aufgeteilt';
  end if;

  with todo as (
    select d.id, d.amount, row_number() over (order by random()) - 1 as k
    from public.drops d
    where d.run_id = p_run and d.id = any(p_drops) and d.sold_price is null
      and not exists (select 1 from public.interests i where i.drop_id = d.id)
  ), people as (
    select p.user_id, row_number() over (order by random()) - 1 as j, count(*) over () as n
    from public.run_participants p
    where p.run_id = p_run
  )
  insert into public.interests (drop_id, user_id, source, share)
  select t.id, p.user_id, 'rest', t.amount
  from todo t join people p on p.j = t.k % p.n;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
