-- Müll ohne NPC-Preis (z. B. Stone, npc_price = 0) wird beim Wechsel „offen“ → „muell“ entsorgt:
-- sold_to_npc = true mit Erlös 0. Vorher blieb er als Konflikt „kein NPC-Preis“ liegen und tauchte in den
-- späteren Phasen immer wieder als übriger Drop auf. Zurück nach „offen“ macht auch das rückgängig.

create or replace function public.set_run_status(p_run bigint, p_status text)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  phases text[] := array['offen', 'muell', 'abholung', 'verkauf', 'auszahlung', 'beendet'];
  v_status text;
  v_from int;
  v_to int;
  v_count integer := 0;
begin
  select status into v_status from public.runs where id = p_run;
  if v_status is null
     or not (public.can_manage_run(p_run) or public.is_party_seller(public.run_party(p_run))) then
    raise exception 'Keine Berechtigung für diesen Run';
  end if;
  v_from := array_position(phases, v_status);
  v_to := array_position(phases, p_status);
  if v_to is null or abs(v_to - v_from) <> 1 or least(v_from, v_to) = 2 then
    raise exception 'Phasenwechsel von % nach % nicht möglich', v_status, p_status;
  end if;

  if v_status = 'offen' and p_status = 'muell' then
    -- Müll ohne Konflikt an NPC verkaufen; ohne NPC-Preis wird er entsorgt (Erlös 0)
    update public.drops d
    set sold_price  = case when coalesce(i.npc_price, 0) > 0
                           then d.amount::bigint * floor(floor(i.npc_price / 2.0) * 124 / 100)::bigint
                           else 0 end,
        sold_to_npc = true,
        sold_by     = auth.uid(),
        sold_at     = now()
    from public.items i
    where i.item_id = d.item_id and d.run_id = p_run
      and d.sold_price is null and d.assigned_to is null
      and exists (select 1 from public.party_trash t where t.party_id = public.run_party(p_run) and t.item_id = d.item_id)
      and not exists (select 1 from public.interests x where x.drop_id = d.id)
      and not exists (select 1 from public.run_participants p
                      join public.wishlist w on w.user_id = p.user_id and w.item_id = d.item_id
                      where p.run_id = p_run);
    get diagnostics v_count = row_count;
  elsif v_status = 'muell' and p_status = 'offen' then
    -- Müll-Verkauf rückgängig machen
    update public.drops
    set sold_price = null, sold_to_npc = false, sold_by = null, sold_at = null
    where run_id = p_run and sold_to_npc;
    get diagnostics v_count = row_count;
  end if;

  update public.runs
  set status = p_status,
      finished_at = case when p_status = 'beendet' then now() end
  where id = p_run;
  return v_count;
end;
$$;
