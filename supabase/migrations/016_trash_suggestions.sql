-- Vorschläge für die Müll-Liste: Items, die in den letzten 10 abgeschlossenen Runs der Party (Phase
-- „auszahlung“ oder „beendet“, inklusive des übergebenen Runs) bei jedem Vorkommen an NPC verkauft wurden,
-- in mindestens 2 Runs vorkamen und noch nicht auf der Müll-Liste stehen. Wird nach dem Beenden angezeigt.

create or replace function public.trash_suggestions(p_run bigint)
returns table (item_id integer, name text, icon text, npc_price integer, runs integer, occurrences integer)
language sql stable security definer set search_path = ''
as $$
  with last_runs as (
    select r.id
    from public.runs r
    where r.party_id = public.run_party(p_run)
      and r.status in ('auszahlung', 'beendet')
    order by coalesce(r.rolled_at, r.created_at) desc
    limit 10
  ), stats as (
    select d.item_id, count(distinct d.run_id)::integer as runs, count(*)::integer as occurrences
    from public.drops d
    where d.run_id in (select id from last_runs)
    group by d.item_id
    having bool_and(d.sold_to_npc) and count(distinct d.run_id) >= 2
  )
  select s.item_id, i.name, i.icon, i.npc_price, s.runs, s.occurrences
  from stats s
  join public.items i on i.item_id = s.item_id
  where public.is_party_member(public.run_party(p_run))
    and not exists (select 1 from public.party_trash t
                    where t.party_id = public.run_party(p_run) and t.item_id = s.item_id)
  order by s.runs desc, i.name;
$$;

revoke all on function public.trash_suggestions(bigint) from public, anon;
grant execute on function public.trash_suggestions(bigint) to authenticated;
