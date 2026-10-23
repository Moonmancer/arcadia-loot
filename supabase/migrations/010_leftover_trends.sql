-- Historie für übrige Drops: was wurde mit einem Item in den letzten 10 Runs der Party gemacht, als es
-- übrig war – an NPC verkauft, als Rest verteilt oder an Spieler verkauft? Daraus schlägt das Frontend
-- in der Phase „Verkauf & Rest“ eine Vorbelegung vor.
--
-- Die Historie wird aus den Run-Daten gelesen (drops.sold_to_npc, drops.sold_price, interests.source =
-- 'rest'); gelöschte Runs fallen heraus. Berücksichtigt werden Runs, deren Verkauf abgeschlossen ist
-- (Phase „auszahlung“ oder „beendet“), ohne den aktuellen Run.

create or replace function public.leftover_trends(p_run bigint)
returns table (item_id integer, rest_count integer, npc_count integer, sold_count integer, runs_considered integer)
language sql stable security definer set search_path = ''
as $$
  with last_runs as (
    select r.id
    from public.runs r
    where r.party_id = public.run_party(p_run)
      and r.id <> p_run
      and r.status in ('auszahlung', 'beendet')
    order by coalesce(r.rolled_at, r.created_at) desc
    limit 10
  ), outcomes as (
    select d.item_id,
           exists (select 1 from public.interests i where i.drop_id = d.id and i.source = 'rest') as is_rest,
           d.sold_to_npc as is_npc,
           d.sold_price is not null and not d.sold_to_npc as is_sold
    from public.drops d
    where d.run_id in (select id from last_runs)
  )
  select o.item_id,
         count(*) filter (where o.is_rest)::integer,
         count(*) filter (where o.is_npc)::integer,
         count(*) filter (where o.is_sold)::integer,
         (select count(*) from last_runs)::integer
  from outcomes o
  where public.is_party_member(public.run_party(p_run))
    and (o.is_rest or o.is_npc or o.is_sold)
  group by o.item_id;
$$;

revoke all on function public.leftover_trends(bigint) from public, anon;
grant execute on function public.leftover_trends(bigint) to authenticated;
