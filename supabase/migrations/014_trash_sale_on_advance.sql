-- Müll wird schon beim Wechsel „offen“ → „muell“ verkauft (Phase heißt im Frontend „Müll verkauft“).
-- Markieren passiert in „offen“. Der Wechsel verkauft alle Müll-Drops ohne Konflikt an NPC (Konflikt:
-- Wunschliste eines Teilnehmers, Interesse, Zuweisung, kein NPC-Preis). Zurück nach „offen“ macht
-- diese Verkäufe rückgängig (vor dem Würfeln stammen NPC-Verkäufe nur aus dem Müll-Verkauf).
-- Würfeln verkauft nichts mehr. Verkaufte Drops nehmen keine Interessen mehr an.

drop function public.set_run_status(bigint, text);
create function public.set_run_status(p_run bigint, p_status text)
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
    -- Müll ohne Konflikt an NPC verkaufen
    update public.drops d
    set sold_price  = d.amount::bigint * floor(floor(i.npc_price / 2.0) * 124 / 100)::bigint,
        sold_to_npc = true,
        sold_by     = auth.uid(),
        sold_at     = now()
    from public.items i
    where i.item_id = d.item_id and d.run_id = p_run
      and i.npc_price > 0 and d.sold_price is null and d.assigned_to is null
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

revoke all on function public.set_run_status(bigint, text) from public, anon;
grant execute on function public.set_run_status(bigint, text) to authenticated;

-- Würfeln ohne Müll-Verkauf
drop function public.roll_run(bigint);
create function public.roll_run(p_run bigint)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.can_manage_run(p_run) then
    raise exception 'Keine Berechtigung für diesen Run';
  end if;

  update public.runs set status = 'abholung', rolled_at = now()
  where id = p_run and status = 'muell';
  if not found then
    raise exception 'Gewürfelt wird nach dem Müll-Verkauf';
  end if;

  update public.interests i
  set roll = 1 + floor(random() * 100)::integer
  from public.drops d
  where d.id = i.drop_id and d.run_id = p_run and d.assigned_to is null;

  with ranked as (
    select i.drop_id, i.user_id, d.amount,
           row_number() over (partition by i.drop_id order by i.roll desc, random()) as rank,
           count(*)     over (partition by i.drop_id) as n
    from public.interests i
    join public.drops d on d.id = i.drop_id
    where d.run_id = p_run and d.assigned_to is null
  )
  update public.interests i
  set share = r.amount / r.n + case when r.rank <= r.amount % r.n then 1 else 0 end
  from ranked r
  where r.drop_id = i.drop_id and r.user_id = i.user_id;
end;
$$;

revoke all on function public.roll_run(bigint) from public, anon;
grant execute on function public.roll_run(bigint) to authenticated;

-- Verkaufte Drops nehmen keine Interessen an (weder manuell noch über die Wunschliste)
drop policy "interesse eintragen" on public.interests;
create policy "interesse eintragen" on public.interests for insert to authenticated
  with check (user_id = auth.uid()
              and exists (select 1 from public.drops d join public.runs r on r.id = d.run_id
                          where d.id = drop_id and d.assigned_to is null and d.sold_price is null
                            and r.status in ('offen', 'muell')
                            and public.is_run_participant(r.id, auth.uid())));

create or replace function public.wishlist_changed()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.interests (drop_id, user_id, source)
    select d.id, new.user_id, 'wunschliste'
    from public.drops d
    join public.runs r on r.id = d.run_id and r.status in ('offen', 'muell')
    join public.run_participants p on p.run_id = r.id and p.user_id = new.user_id
    where d.item_id = new.item_id and d.assigned_to is null and d.sold_price is null
    on conflict do nothing;
  else
    delete from public.interests i
    using public.drops d, public.runs r
    where d.id = i.drop_id and r.id = d.run_id and r.status in ('offen', 'muell')
      and i.user_id = old.user_id and d.item_id = old.item_id and i.source = 'wunschliste';
  end if;
  return null;
end;
$$;

create or replace function public.run_participant_changed()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.interests (drop_id, user_id, source)
    select d.id, new.user_id, 'wunschliste'
    from public.drops d
    join public.runs r on r.id = d.run_id and r.status in ('offen', 'muell')
    join public.wishlist w on w.user_id = new.user_id and w.item_id = d.item_id
    where d.run_id = new.run_id and d.assigned_to is null and d.sold_price is null
    on conflict do nothing;
  else
    delete from public.interests i
    using public.drops d, public.runs r
    where d.id = i.drop_id and r.id = d.run_id and r.status in ('offen', 'muell')
      and d.run_id = old.run_id and i.user_id = old.user_id;
    update public.drops d
    set assigned_to = null
    from public.runs r
    where r.id = d.run_id and r.status in ('offen', 'muell') and d.run_id = old.run_id and d.assigned_to = old.user_id;
  end if;
  return null;
end;
$$;
