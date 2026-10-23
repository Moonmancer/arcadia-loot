-- Rollen in Partys, Partypreis, Verkaufserlöse, Preis-Override und direkte Zuweisung
--
-- Abrechnung (wie bisher im Google Doc): Wer ein Item bekommt, zahlt den Partypreis
-- (party_price_pct % vom Stückpreis × Menge) in die Kasse. Kasse + Verkaufserlöse werden auf
-- die Mitglieder aufgeteilt. Berechnet wird das im Frontend aus den gespeicherten Werten.
--
-- Rollen:
--   admin       – Mitglieder, Rollen und Partypreis verwalten, alle Runs verwalten (importieren, würfeln,
--                 löschen), Stückpreis eines Drops überschreiben, Drops direkt einem Mitglied zuweisen
--   verkaeufer  – wie Teilnehmer, zusätzlich Verkaufserlöse für Drops ohne Interessenten erfassen
--   teilnehmer  – Interesse eintragen, eigene Runs anlegen und verwalten
-- Mehrere Admins sind möglich; der letzte Admin kann nicht entfernt oder herabgestuft werden.

-- Rollen umbenennen
alter table public.party_members drop constraint party_members_role_check;
update public.party_members set role = case role when 'leader' then 'admin' else 'teilnehmer' end;
alter table public.party_members
  alter column role set default 'teilnehmer',
  add constraint party_members_role_check check (role in ('admin', 'verkaeufer', 'teilnehmer'));

-- Partypreis in Prozent vom Marktpreis, pro Party
alter table public.parties
  add column party_price_pct integer not null default 75 check (party_price_pct between 0 and 100);
grant update (party_price_pct) on public.parties to authenticated;

-- Name bleibt, damit die Policies aus 002 weiter greifen; bedeutet jetzt „ist Admin"
create or replace function public.is_party_leader(p_party bigint)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.party_members
                 where party_id = p_party and user_id = auth.uid() and role = 'admin');
$$;

create or replace function public.is_party_seller(p_party bigint)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.party_members
                 where party_id = p_party and user_id = auth.uid() and role in ('admin', 'verkaeufer'));
$$;

create or replace function public.add_party_creator()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.party_members (party_id, user_id, role) values (new.id, new.created_by, 'admin');
  return new;
end;
$$;

-- Letzten Admin schützen (außer die ganze Party wird gelöscht)
create or replace function public.keep_last_admin()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.role = 'admin'
     and (tg_op = 'DELETE' or new.role <> 'admin')
     and exists (select 1 from public.parties where id = old.party_id)
     and not exists (select 1 from public.party_members
                     where party_id = old.party_id and role = 'admin' and user_id <> old.user_id) then
    raise exception 'Die Party braucht mindestens einen Admin';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger keep_last_admin
  before update of role or delete on public.party_members
  for each row execute function public.keep_last_admin();

revoke all on function public.keep_last_admin() from public, anon, authenticated;

-- Verkäufe
alter table public.drops
  add column sold_price bigint check (sold_price >= 0),   -- Gesamterlös für den ganzen Drop (Zeny)
  add column sold_by    uuid references public.profiles on delete set null,
  add column sold_at    timestamptz,
  add column price_override bigint check (price_override >= 0),   -- Stückpreis, ersetzt den Marktpreis
  add column assigned_to    uuid references public.profiles on delete set null;  -- direkt zugewiesen

-- Erlös setzen oder mit null zurücknehmen. Nur Admin/Verkäufer, nur gewürfelte Runs,
-- nur Drops ohne Interessenten.
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
  if v_status <> 'gewuerfelt' then
    raise exception 'Verkäufe erst nach dem Würfeln erfassen';
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

revoke all on function public.set_sale(bigint, bigint) from public, anon;
grant execute on function public.set_sale(bigint, bigint) to authenticated;

-- Preis überschreiben (Stückpreis, null = Marktpreis). Nur Admin, jederzeit.
create or replace function public.set_price(p_drop bigint, p_price bigint)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not exists (select 1 from public.drops d join public.runs r on r.id = d.run_id
                 where d.id = p_drop and public.is_party_leader(r.party_id)) then
    raise exception 'Nur Admins können Preise überschreiben';
  end if;
  if p_price < 0 then
    raise exception 'Preis darf nicht negativ sein';
  end if;
  update public.drops set price_override = p_price where id = p_drop;
end;
$$;

-- Direkte Zuweisung
alter table public.interests drop constraint interests_source_check;
alter table public.interests
  add constraint interests_source_check check (source in ('manuell', 'wunschliste', 'zuweisung'));

-- Drop komplett einem Mitglied zuweisen (p_user = null hebt die Zuweisung auf). Nur Admin, auch nach
-- dem Würfeln (Korrektur). Andere Interessen am Drop werden entfernt, ein erfasster Verkauf verworfen.
-- Aufheben in einem offenen Run trägt die Wunschlisten-Interessen wieder ein.
create or replace function public.assign_drop(p_drop bigint, p_user uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_party bigint;
  v_status text;
  v_item integer;
  v_amount integer;
begin
  select r.party_id, r.status, d.item_id, d.amount into v_party, v_status, v_item, v_amount
  from public.drops d join public.runs r on r.id = d.run_id
  where d.id = p_drop;

  if v_party is null or not public.is_party_leader(v_party) then
    raise exception 'Nur Admins können Drops zuweisen';
  end if;
  if p_user is not null and not exists (select 1 from public.party_members
                                        where party_id = v_party and user_id = p_user) then
    raise exception 'Nur Mitglieder der Party können Drops bekommen';
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
    select p_drop, m.user_id, 'wunschliste'
    from public.party_members m
    join public.wishlist w on w.user_id = m.user_id and w.item_id = v_item
    where m.party_id = v_party;
  end if;
end;
$$;

revoke all on function public.set_price(bigint, bigint), public.assign_drop(bigint, uuid) from public, anon;
grant execute on function public.set_price(bigint, bigint), public.assign_drop(bigint, uuid) to authenticated;

-- Zugewiesene Drops: kein eigenes Interesse eintragen, Zuweisung nicht selbst zurückziehen
drop policy "interesse eintragen" on public.interests;
create policy "interesse eintragen" on public.interests for insert to authenticated
  with check (user_id = auth.uid()
              and exists (select 1 from public.drops d join public.runs r on r.id = d.run_id
                          where d.id = drop_id and d.assigned_to is null
                            and r.status = 'offen' and public.is_party_member(r.party_id)));
drop policy "interesse zurückziehen" on public.interests;
create policy "interesse zurückziehen" on public.interests for delete to authenticated
  using (user_id = auth.uid() and source <> 'zuweisung'
         and exists (select 1 from public.drops d join public.runs r on r.id = d.run_id
                     where d.id = drop_id and r.status = 'offen'));

-- Würfeln überspringt zugewiesene Drops (deren Anteil steht schon fest)
create or replace function public.roll_run(p_run bigint)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.can_manage_run(p_run) then
    raise exception 'Keine Berechtigung für diesen Run';
  end if;

  update public.runs set status = 'gewuerfelt', rolled_at = now()
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

-- Wunschlisten-Trigger: zugewiesene Drops nicht anfassen; wer die Party verlässt, verliert Zuweisungen
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
    join public.party_members m on m.party_id = r.party_id and m.user_id = new.user_id
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

create or replace function public.wishlist_on_membership()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.interests (drop_id, user_id, source)
    select d.id, new.user_id, 'wunschliste'
    from public.runs r
    join public.drops d on d.run_id = r.id and d.assigned_to is null
    join public.wishlist w on w.user_id = new.user_id and w.item_id = d.item_id
    where r.party_id = new.party_id and r.status = 'offen'
    on conflict do nothing;
  else
    delete from public.interests i
    using public.drops d, public.runs r
    where d.id = i.drop_id and r.id = d.run_id and r.status = 'offen'
      and r.party_id = old.party_id and i.user_id = old.user_id;
    update public.drops d
    set assigned_to = null
    from public.runs r
    where r.id = d.run_id and r.status = 'offen' and r.party_id = old.party_id
      and d.assigned_to = old.user_id;
  end if;
  return null;
end;
$$;

-- View neu anlegen, damit die neuen Spalten von drops enthalten sind
drop view public.drop_overview;
create view public.drop_overview
with (security_invoker = true)
as
select d.*,
       r.party_id,
       r.status as run_status,
       i.icon,
       i.type as item_type,
       (d.attributes is null and d.cards is null) as is_plain,   -- nur dann passt der Marktpreis
       p.sell_min,
       p.sell_median,
       p.buy_max,
       p.sell_seen_at,
       (select count(*) from public.interests x where x.drop_id = d.id) as interest_count
from public.drops d
join public.runs r on r.id = d.run_id
left join public.items i on i.item_id = d.item_id
left join public.item_prices p on p.item_id = d.item_id;

revoke all on public.drop_overview from anon, authenticated;
grant select on public.drop_overview to authenticated, service_role;
