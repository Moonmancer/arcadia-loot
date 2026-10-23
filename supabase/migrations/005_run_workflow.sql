-- Run-Workflow, Run-Teilnehmer, Abholung, Rest-Aufteilung und Auszahlung
--
-- Phasen (runs.status):
--   offen       – Run erstellt, Loot einfügen, Teilnehmer festlegen, Interessen eintragen
--   abholung    – gewürfelt; Teilnehmer holen ihre Anteile ab (interests.picked_up_at)
--   verkauf     – Rest ohne Interessenten wird verkauft (drops.sold_price) oder gratis zufällig unter den
--                 Teilnehmern aufgeteilt (interests.source = 'rest'); auch Rest wird abgeholt
--   auszahlung  – Kasse (Partypreise + Verkäufe) wird an die Teilnehmer ausgezahlt (run_participants.paid_at)
--   beendet     – nur noch lesen
--
-- Run-Teilnehmer: beim Anlegen alle Party-Mitglieder; der Run-Verwalter kann in der Phase „offen“
-- Teilnehmer ab- und hinzuwählen. Nur Teilnehmer können Interesse anmelden, bekommen Zuweisungen,
-- Rest und einen Anteil an der Kasse.
--
-- Abhaken: „abgeholt“ jeder für sich selbst, Admin/Verkäufer für alle; „ausgezahlt“ nur Admin/Verkäufer.
-- Phasenwechsel: Run-Verwalter (Ersteller oder Admin) oder Verkäufer, je einen Schritt vor oder zurück
-- (nicht zurück nach „offen“, Würfeln ist endgültig).

-- Phasen
alter table public.runs drop constraint runs_status_check;
update public.runs set status = 'abholung' where status = 'gewuerfelt';
alter table public.runs
  add constraint runs_status_check check (status in ('offen', 'abholung', 'verkauf', 'auszahlung', 'beendet')),
  add column finished_at timestamptz;

-- Run-Teilnehmer
create table public.run_participants (
  run_id   bigint not null references public.runs on delete cascade,
  user_id  uuid not null references public.profiles on delete cascade,
  paid_at  timestamptz,                 -- Auszahlung erledigt
  paid_by  uuid references public.profiles on delete set null,
  primary key (run_id, user_id)
);

create index on public.run_participants (user_id);

-- Bestehende Runs: alle aktuellen Mitglieder sind Teilnehmer
insert into public.run_participants (run_id, user_id)
select r.id, m.user_id from public.runs r join public.party_members m on m.party_id = r.party_id;

create or replace function public.is_run_participant(p_run bigint, p_user uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.run_participants where run_id = p_run and user_id = p_user);
$$;

create or replace function public.run_party(p_run bigint)
returns bigint
language sql stable security definer set search_path = ''
as $$
  select party_id from public.runs where id = p_run;
$$;

alter table public.run_participants enable row level security;

create policy "teilnehmer lesen" on public.run_participants for select to authenticated
  using (public.is_party_member(public.run_party(run_id)));
create policy "teilnehmer hinzufügen" on public.run_participants for insert to authenticated
  with check (public.can_manage_run(run_id)
              and exists (select 1 from public.runs r where r.id = run_id and r.status = 'offen')
              and exists (select 1 from public.party_members m
                          where m.party_id = public.run_party(run_id) and m.user_id = run_participants.user_id));
create policy "teilnehmer entfernen" on public.run_participants for delete to authenticated
  using (public.can_manage_run(run_id)
         and exists (select 1 from public.runs r where r.id = run_id and r.status = 'offen'));

revoke all on public.run_participants from anon, authenticated;
grant select, delete on public.run_participants to authenticated;
grant insert (run_id, user_id) on public.run_participants to authenticated;
grant select, insert, update, delete on public.run_participants to service_role;

-- Neuer Run: alle Party-Mitglieder als Teilnehmer
create or replace function public.add_run_participants()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.run_participants (run_id, user_id)
  select new.id, m.user_id from public.party_members m where m.party_id = new.party_id;
  return null;
end;
$$;

create trigger on_run_created
  after insert on public.runs
  for each row execute function public.add_run_participants();

-- Teilnehmer hinzugefügt / entfernt (nur in „offen“ möglich): Wunschliste anwenden bzw. aufräumen
create or replace function public.run_participant_changed()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.interests (drop_id, user_id, source)
    select d.id, new.user_id, 'wunschliste'
    from public.drops d
    join public.runs r on r.id = d.run_id and r.status = 'offen'
    join public.wishlist w on w.user_id = new.user_id and w.item_id = d.item_id
    where d.run_id = new.run_id and d.assigned_to is null
    on conflict do nothing;
  else
    delete from public.interests i
    using public.drops d, public.runs r
    where d.id = i.drop_id and r.id = d.run_id and r.status = 'offen'
      and d.run_id = old.run_id and i.user_id = old.user_id;
    update public.drops d
    set assigned_to = null
    from public.runs r
    where r.id = d.run_id and r.status = 'offen' and d.run_id = old.run_id and d.assigned_to = old.user_id;
  end if;
  return null;
end;
$$;

create trigger run_participant_changed
  after insert or delete on public.run_participants
  for each row execute function public.run_participant_changed();

-- Wunschliste: nur Runs, an denen man teilnimmt
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
  where r.id = new.run_id and r.status = 'offen'
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
    join public.runs r on r.id = d.run_id and r.status = 'offen'
    join public.run_participants p on p.run_id = r.id and p.user_id = new.user_id
    where d.item_id = new.item_id and d.assigned_to is null
    on conflict do nothing;
  else
    delete from public.interests i
    using public.drops d, public.runs r
    where d.id = i.drop_id and r.id = d.run_id and r.status = 'offen'
      and i.user_id = old.user_id and d.item_id = old.item_id and i.source = 'wunschliste';
  end if;
  return null;
end;
$$;

-- Party-Beitritt macht nicht automatisch zum Teilnehmer laufender Runs; Austritt entfernt aus offenen Runs
create or replace function public.wishlist_on_membership()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    delete from public.run_participants p
    using public.runs r
    where r.id = p.run_id and r.party_id = old.party_id and r.status = 'offen' and p.user_id = old.user_id;
  end if;
  return null;
end;
$$;

-- Interessen: nur Teilnehmer
drop policy "interesse eintragen" on public.interests;
create policy "interesse eintragen" on public.interests for insert to authenticated
  with check (user_id = auth.uid()
              and exists (select 1 from public.drops d join public.runs r on r.id = d.run_id
                          where d.id = drop_id and d.assigned_to is null and r.status = 'offen'
                            and public.is_run_participant(r.id, auth.uid())));

-- Abholung
alter table public.interests
  add column picked_up_at timestamptz,
  add column picked_up_by uuid references public.profiles on delete set null;

alter table public.interests drop constraint interests_source_check;
alter table public.interests
  add constraint interests_source_check check (source in ('manuell', 'wunschliste', 'zuweisung', 'rest'));

-- Würfeln: wechselt in die Phase „abholung“
create or replace function public.roll_run(p_run bigint)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.can_manage_run(p_run) then
    raise exception 'Keine Berechtigung für diesen Run';
  end if;

  update public.runs set status = 'abholung', rolled_at = now()
  where id = p_run and status = 'offen';
  if not found then
    raise exception 'Run ist bereits gewürfelt';
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

-- Phase wechseln: ein Schritt vor oder zurück (nicht zurück nach „offen“)
create or replace function public.set_run_status(p_run bigint, p_status text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  phases text[] := array['offen', 'abholung', 'verkauf', 'auszahlung', 'beendet'];
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
  if v_to is null or v_to < 2 or v_from < 2 or abs(v_to - v_from) <> 1 then
    raise exception 'Phasenwechsel von % nach % nicht möglich', v_status, p_status;
  end if;
  update public.runs
  set status = p_status,
      finished_at = case when p_status = 'beendet' then now() end
  where id = p_run;
end;
$$;

-- Abgeholt setzen/zurücknehmen: der Empfänger selbst oder Admin/Verkäufer
create or replace function public.set_picked_up(p_drop bigint, p_user uuid, p_done boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_run bigint;
  v_status text;
begin
  select r.id, r.status into v_run, v_status
  from public.drops d join public.runs r on r.id = d.run_id where d.id = p_drop;
  if v_run is null
     or not (p_user = auth.uid() or public.is_party_seller(public.run_party(v_run))) then
    raise exception 'Keine Berechtigung';
  end if;
  if v_status not in ('abholung', 'verkauf', 'auszahlung') then
    raise exception 'Abholung ist in dieser Phase nicht möglich';
  end if;
  update public.interests
  set picked_up_at = case when p_done then now() end,
      picked_up_by = case when p_done then auth.uid() end
  where drop_id = p_drop and user_id = p_user and share > 0;
  if not found then
    raise exception 'Kein Anteil zum Abholen';
  end if;
end;
$$;

-- Rest gratis zufällig unter den Teilnehmern aufteilen: gleichmäßig, Rest stückweise per Zufall
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
    select d.id, d.amount from public.drops d
    where d.run_id = p_run and d.id = any(p_drops) and d.sold_price is null
      and not exists (select 1 from public.interests i where i.drop_id = d.id)
  ), ranked as (
    select t.id as drop_id, p.user_id, t.amount,
           row_number() over (partition by t.id order by random()) as rank,
           count(*)     over (partition by t.id) as n
    from todo t cross join public.run_participants p
    where p.run_id = p_run
  )
  insert into public.interests (drop_id, user_id, source, share)
  select drop_id, user_id, 'rest', amount / n + case when rank <= amount % n then 1 else 0 end
  from ranked;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Rest-Aufteilung eines Drops zurücknehmen (solange niemand abgeholt hat)
create or replace function public.undo_rest(p_drop bigint)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_run bigint;
begin
  select run_id into v_run from public.drops where id = p_drop;
  if v_run is null or not public.is_party_seller(public.run_party(v_run)) then
    raise exception 'Nur Admins und Verkäufer können Rest aufteilen';
  end if;
  if (select status from public.runs where id = v_run) <> 'verkauf' then
    raise exception 'Nur in der Phase „Verkauf“ möglich';
  end if;
  if exists (select 1 from public.interests where drop_id = p_drop and source = 'rest' and picked_up_at is not null) then
    raise exception 'Schon abgeholt – erst die Abholung zurücknehmen';
  end if;
  delete from public.interests where drop_id = p_drop and source = 'rest';
end;
$$;

-- Ausgezahlt setzen/zurücknehmen: Admin/Verkäufer in der Phase „auszahlung“
create or replace function public.set_paid(p_run bigint, p_user uuid, p_done boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.is_party_seller(public.run_party(p_run)) then
    raise exception 'Nur Admins und Verkäufer können Auszahlungen abhaken';
  end if;
  if (select status from public.runs where id = p_run) <> 'auszahlung' then
    raise exception 'Auszahlung ist in dieser Phase nicht möglich';
  end if;
  update public.run_participants
  set paid_at = case when p_done then now() end,
      paid_by = case when p_done then auth.uid() end
  where run_id = p_run and user_id = p_user;
  if not found then
    raise exception 'Kein Teilnehmer dieses Runs';
  end if;
end;
$$;

-- Bestehende Funktionen an die Phasen anpassen
create or replace function public.set_sale(p_drop bigint, p_price bigint)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_party bigint;
  v_status text;
begin
  select r.party_id, r.status into v_party, v_status
  from public.drops d join public.runs r on r.id = d.run_id
  where d.id = p_drop;

  if v_party is null or not public.is_party_seller(v_party) then
    raise exception 'Nur Admins und Verkäufer können Verkäufe erfassen';
  end if;
  if v_status not in ('abholung', 'verkauf') then
    raise exception 'Verkäufe werden nach dem Würfeln bis zur Auszahlung erfasst';
  end if;
  if exists (select 1 from public.interests where drop_id = p_drop) then
    raise exception 'Dieser Drop wurde verteilt, nicht verkauft';
  end if;
  if p_price < 0 then
    raise exception 'Erlös darf nicht negativ sein';
  end if;

  update public.drops
  set sold_price = p_price,
      sold_by    = case when p_price is null then null else auth.uid() end,
      sold_at    = case when p_price is null then null else now() end
  where id = p_drop;
end;
$$;

create or replace function public.set_price(p_drop bigint, p_price bigint)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not exists (select 1 from public.drops d join public.runs r on r.id = d.run_id
                 where d.id = p_drop and public.is_party_leader(r.party_id)) then
    raise exception 'Nur Admins können Preise überschreiben';
  end if;
  if exists (select 1 from public.drops d join public.runs r on r.id = d.run_id
             where d.id = p_drop and r.status in ('auszahlung', 'beendet')) then
    raise exception 'Preise sind ab der Auszahlung fest';
  end if;
  if p_price < 0 then
    raise exception 'Preis darf nicht negativ sein';
  end if;
  update public.drops set price_override = p_price where id = p_drop;
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
  elsif v_status = 'offen' then
    insert into public.interests (drop_id, user_id, source)
    select p_drop, p.user_id, 'wunschliste'
    from public.run_participants p
    join public.wishlist w on w.user_id = p.user_id and w.item_id = v_item
    where p.run_id = v_run;
  end if;
end;
$$;

revoke all on function public.set_run_status(bigint, text), public.set_picked_up(bigint, uuid, boolean),
  public.split_rest(bigint, bigint[]), public.undo_rest(bigint), public.set_paid(bigint, uuid, boolean)
  from public, anon;
grant execute on function public.set_run_status(bigint, text), public.set_picked_up(bigint, uuid, boolean),
  public.split_rest(bigint, bigint[]), public.undo_rest(bigint), public.set_paid(bigint, uuid, boolean)
  to authenticated;
revoke all on function public.add_run_participants(), public.run_participant_changed() from public, anon, authenticated;
