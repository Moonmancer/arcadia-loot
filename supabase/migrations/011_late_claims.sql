-- Nachmelden nach dem Würfeln: In der Phase „abholung“ kann jedes Party-Mitglied – auch wer nicht beim
-- Run war – einen übrigen Drop (ohne Interessenten, nicht verkauft, nicht zugewiesen) übernehmen.
-- Wer zuerst kommt, bekommt den Drop komplett und zahlt dafür den Partypreis in die Kasse
-- (interests.source = 'nachmeldung'). Einen Kassenanteil bekommen weiterhin nur Run-Teilnehmer.
-- Mit dem Wechsel zu „verkauf“ ist Schluss. Solange nicht abgeholt, kann man den Drop zurückgeben.

alter table public.interests drop constraint interests_source_check;
alter table public.interests
  add constraint interests_source_check
  check (source in ('manuell', 'wunschliste', 'zuweisung', 'rest', 'nachmeldung'));

create or replace function public.claim_drop(p_drop bigint)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_party bigint;
  v_status text;
  v_amount integer;
  v_sold bigint;
  v_assigned uuid;
begin
  -- Zeile sperren, damit bei gleichzeitigen Meldungen nur die erste gewinnt
  select r.party_id, r.status, d.amount, d.sold_price, d.assigned_to
    into v_party, v_status, v_amount, v_sold, v_assigned
  from public.drops d join public.runs r on r.id = d.run_id
  where d.id = p_drop
  for update of d;

  if v_party is null or not public.is_party_member(v_party) then
    raise exception 'Nur Mitglieder der Party können Items übernehmen';
  end if;
  if v_status <> 'abholung' then
    raise exception 'Nachmelden geht nur während der Abholung';
  end if;
  if v_sold is not null or v_assigned is not null
     or exists (select 1 from public.interests where drop_id = p_drop) then
    raise exception 'Zu spät – dieses Item ist schon vergeben';
  end if;

  insert into public.interests (drop_id, user_id, source, share)
  values (p_drop, auth.uid(), 'nachmeldung', v_amount);
end;
$$;

create or replace function public.unclaim_drop(p_drop bigint)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if (select r.status from public.drops d join public.runs r on r.id = d.run_id where d.id = p_drop) <> 'abholung' then
    raise exception 'Zurückgeben geht nur während der Abholung';
  end if;
  delete from public.interests
  where drop_id = p_drop and user_id = auth.uid() and source = 'nachmeldung' and picked_up_at is null;
  if not found then
    raise exception 'Nichts zurückzugeben (schon abgeholt oder nicht von dir übernommen)';
  end if;
end;
$$;

revoke all on function public.claim_drop(bigint), public.unclaim_drop(bigint) from public, anon;
grant execute on function public.claim_drop(bigint), public.unclaim_drop(bigint) to authenticated;
