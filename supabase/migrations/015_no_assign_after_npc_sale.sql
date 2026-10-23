-- An NPC verkaufte Drops können nicht mehr direkt zugewiesen werden (das Item ist weg). Ein manuell
-- erfasster Verkauf an Spieler wird wie bisher durch eine Zuweisung verworfen.

create or replace function public.assign_drop(p_drop bigint, p_user uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_run bigint;
  v_party bigint;
  v_status text;
  v_item integer;
  v_amount integer;
  v_npc boolean;
begin
  select r.id, r.party_id, r.status, d.item_id, d.amount, d.sold_to_npc
    into v_run, v_party, v_status, v_item, v_amount, v_npc
  from public.drops d join public.runs r on r.id = d.run_id
  where d.id = p_drop;

  if v_party is null or not public.is_party_leader(v_party) then
    raise exception 'Nur Admins können Drops zuweisen';
  end if;
  if v_status in ('auszahlung', 'beendet') then
    raise exception 'Zuweisungen sind ab der Auszahlung fest';
  end if;
  if v_npc then
    raise exception 'Dieser Drop wurde an NPC verkauft und kann nicht mehr zugewiesen werden';
  end if;
  if p_user is not null and not public.is_run_participant(v_run, p_user) then
    raise exception 'Nur Teilnehmer des Runs können Drops bekommen';
  end if;

  delete from public.interests where drop_id = p_drop;
  update public.drops
  set assigned_to = p_user, sold_price = null, sold_by = null, sold_at = null
  where id = p_drop;

  if p_user is not null then
    insert into public.interests (drop_id, user_id, source, share)
    values (p_drop, p_user, 'zuweisung', v_amount);
  elsif v_status in ('offen', 'muell') then
    insert into public.interests (drop_id, user_id, source)
    select p_drop, p.user_id, 'wunschliste'
    from public.run_participants p
    join public.wishlist w on w.user_id = p.user_id and w.item_id = v_item
    where p.run_id = v_run;
  end if;
end;
$$;
