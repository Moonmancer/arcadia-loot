-- Phase „Müll verkaufen“ zwischen „Loot befüllt“ und „Ausgewürfelt“ und Müll-Liste pro Party
--
-- Phasen: offen → muell → (Würfeln) → abholung → verkauf → auszahlung → beendet
--   offen   – Run erstellt, Loot einfügen, Teilnehmer, Interessen
--   muell   – Admins markieren Müll (Müll-Liste der Party); Interessen und Teilnehmer noch änderbar
-- Würfeln geht nur aus „muell“. Dabei werden alle Müll-Drops automatisch an NPC verkauft
-- (Erlös = Menge × NPC-Verkaufspreis), außer bei Konflikten: Item steht auf der Wunschliste eines
-- Teilnehmers, jemand hat Interesse eingetragen, Drop ist zugewiesen oder es gibt keinen NPC-Preis.

alter table public.runs drop constraint runs_status_check;
alter table public.runs
  add constraint runs_status_check
  check (status in ('offen', 'muell', 'abholung', 'verkauf', 'auszahlung', 'beendet'));

-- Müll-Liste pro Party
create table public.party_trash (
  party_id   bigint not null references public.parties on delete cascade,
  item_id    integer not null references public.items,
  added_by   uuid default auth.uid() references public.profiles on delete set null,
  created_at timestamptz not null default now(),
  primary key (party_id, item_id)
);

alter table public.party_trash enable row level security;

create policy "müll lesen" on public.party_trash for select to authenticated
  using (public.is_party_member(party_id));
create policy "müll hinzufügen" on public.party_trash for insert to authenticated
  with check (public.is_party_leader(party_id));
create policy "müll entfernen" on public.party_trash for delete to authenticated
  using (public.is_party_leader(party_id));

revoke all on public.party_trash from anon, authenticated;
grant select, delete on public.party_trash to authenticated;
grant insert (party_id, item_id) on public.party_trash to authenticated;
grant select, insert, update, delete on public.party_trash to service_role;

-- Wunschlisten-Konflikte im Run: welche Teilnehmer haben das Item eines Drops auf der Wunschliste?
-- (Wunschlisten sind sonst nur für den Besitzer lesbar.)
create or replace function public.wishlist_conflicts(p_run bigint)
returns table (drop_id bigint, names text[])
language sql stable security definer set search_path = ''
as $$
  select d.id, array_agg(pr.display_name order by pr.display_name)
  from public.drops d
  join public.run_participants p on p.run_id = d.run_id
  join public.wishlist w on w.user_id = p.user_id and w.item_id = d.item_id
  join public.profiles pr on pr.id = p.user_id
  where d.run_id = p_run and public.is_party_member(public.run_party(p_run))
  group by d.id;
$$;

revoke all on function public.wishlist_conflicts(bigint) from public, anon;
grant execute on function public.wishlist_conflicts(bigint) to authenticated;

-- „Vor dem Würfeln“ heißt jetzt offen oder muell
drop policy "interesse eintragen" on public.interests;
create policy "interesse eintragen" on public.interests for insert to authenticated
  with check (user_id = auth.uid()
              and exists (select 1 from public.drops d join public.runs r on r.id = d.run_id
                          where d.id = drop_id and d.assigned_to is null and r.status in ('offen', 'muell')
                            and public.is_run_participant(r.id, auth.uid())));
drop policy "interesse zurückziehen" on public.interests;
create policy "interesse zurückziehen" on public.interests for delete to authenticated
  using (user_id = auth.uid() and source <> 'zuweisung'
         and exists (select 1 from public.drops d join public.runs r on r.id = d.run_id
                     where d.id = drop_id and r.status in ('offen', 'muell')));

drop policy "drop löschen" on public.drops;
create policy "drop löschen" on public.drops for delete to authenticated
  using (public.can_manage_run(run_id)
         and exists (select 1 from public.runs r where r.id = run_id and r.status in ('offen', 'muell')));

drop policy "teilnehmer hinzufügen" on public.run_participants;
create policy "teilnehmer hinzufügen" on public.run_participants for insert to authenticated
  with check (public.can_manage_run(run_id)
              and exists (select 1 from public.runs r where r.id = run_id and r.status in ('offen', 'muell'))
              and exists (select 1 from public.party_members m
                          where m.party_id = public.run_party(run_id) and m.user_id = run_participants.user_id));
drop policy "teilnehmer entfernen" on public.run_participants;
create policy "teilnehmer entfernen" on public.run_participants for delete to authenticated
  using (public.can_manage_run(run_id)
         and exists (select 1 from public.runs r where r.id = run_id and r.status in ('offen', 'muell')));

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
    where d.run_id = new.run_id and d.assigned_to is null
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

create or replace function public.wishlist_on_drop()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.interests (drop_id, user_id, source)
  select new.id, p.user_id, 'wunschliste'
  from public.runs r
  join public.run_participants p on p.run_id = r.id
  join public.wishlist w on w.user_id = p.user_id and w.item_id = new.item_id
  where r.id = new.run_id and r.status in ('offen', 'muell')
  on conflict do nothing;
  return null;
end;
$$;

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
    where d.item_id = new.item_id and d.assigned_to is null
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

create or replace function public.wishlist_on_membership()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    delete from public.run_participants p
    using public.runs r
    where r.id = p.run_id and r.party_id = old.party_id and r.status in ('offen', 'muell') and p.user_id = old.user_id;
  end if;
  return null;
end;
$$;

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
begin
  select r.id, r.party_id, r.status, d.item_id, d.amount into v_run, v_party, v_status, v_item, v_amount
  from public.drops d join public.runs r on r.id = d.run_id
  where d.id = p_drop;

  if v_party is null or not public.is_party_leader(v_party) then
    raise exception 'Nur Admins können Drops zuweisen';
  end if;
  if v_status in ('auszahlung', 'beendet') then
    raise exception 'Zuweisungen sind ab der Auszahlung fest';
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

-- Phase wechseln: ein Schritt vor oder zurück; über das Würfeln (muell ↔ abholung) geht es nicht
create or replace function public.set_run_status(p_run bigint, p_status text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  phases text[] := array['offen', 'muell', 'abholung', 'verkauf', 'auszahlung', 'beendet'];
  v_status text;
  v_from int;
  v_to int;
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
  update public.runs
  set status = p_status,
      finished_at = case when p_status = 'beendet' then now() end
  where id = p_run;
end;
$$;

-- Würfeln aus „muell“: erst Müll ohne Konflikt an NPC verkaufen, dann würfeln. Gibt die Anzahl
-- verkaufter Müll-Drops zurück.
drop function public.roll_run(bigint);
create function public.roll_run(p_run bigint)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_trash integer;
begin
  if not public.can_manage_run(p_run) then
    raise exception 'Keine Berechtigung für diesen Run';
  end if;

  update public.runs set status = 'abholung', rolled_at = now()
  where id = p_run and status = 'muell';
  if not found then
    raise exception 'Gewürfelt wird aus der Phase „Müll verkaufen“';
  end if;

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
  get diagnostics v_trash = row_count;

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

  return v_trash;
end;
$$;

revoke all on function public.roll_run(bigint) from public, anon;
grant execute on function public.roll_run(bigint) to authenticated;
