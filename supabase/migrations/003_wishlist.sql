-- Wunschliste: jeder Nutzer pflegt eine Liste von Items. In jeder Party, in der er Mitglied ist,
-- wird er bei passenden Drops offener Runs automatisch als Interessent eingetragen.
-- Abgeglichen wird nur über die Item-ID (Refine/Karten egal).
--
-- Auslöser:
--   Drop importiert        → Mitglieder mit dem Item auf der Wunschliste eintragen
--   Wunsch hinzugefügt     → bei passenden Drops in allen offenen Runs seiner Partys eintragen
--   Wunsch entfernt        → automatisch eingetragene Interessen in offenen Runs entfernen
--   Party beigetreten      → bei passenden Drops offener Runs dieser Party eintragen
--   Party verlassen        → Interessen in offenen Runs dieser Party entfernen
-- Manuell eingetragene oder zurückgezogene Interessen bleiben unberührt; gewürfelte Runs auch.

create table public.wishlist (
  user_id    uuid not null default auth.uid() references public.profiles on delete cascade,
  item_id    integer not null references public.items,
  created_at timestamptz not null default now(),
  primary key (user_id, item_id)
);

create index on public.wishlist (item_id);

alter table public.interests
  add column source text not null default 'manuell' check (source in ('manuell', 'wunschliste'));

alter table public.wishlist enable row level security;

create policy "wunschliste lesen"     on public.wishlist for select to authenticated using (user_id = auth.uid());
create policy "wunsch hinzufügen"     on public.wishlist for insert to authenticated with check (user_id = auth.uid());
create policy "wunsch entfernen"      on public.wishlist for delete to authenticated using (user_id = auth.uid());

revoke all on public.wishlist from anon, authenticated;
grant select, delete on public.wishlist to authenticated;
grant insert (item_id) on public.wishlist to authenticated;
grant select, insert, update, delete on public.wishlist to service_role;

-- Drop importiert
create or replace function public.wishlist_on_drop()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.interests (drop_id, user_id, source)
  select new.id, m.user_id, 'wunschliste'
  from public.runs r
  join public.party_members m on m.party_id = r.party_id
  join public.wishlist w on w.user_id = m.user_id and w.item_id = new.item_id
  where r.id = new.run_id and r.status = 'offen'
  on conflict do nothing;
  return null;
end;
$$;

create trigger wishlist_on_drop
  after insert on public.drops
  for each row execute function public.wishlist_on_drop();

-- Wunsch hinzugefügt / entfernt
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
    where d.item_id = new.item_id
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

create trigger wishlist_changed
  after insert or delete on public.wishlist
  for each row execute function public.wishlist_changed();

-- Party beigetreten / verlassen
create or replace function public.wishlist_on_membership()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.interests (drop_id, user_id, source)
    select d.id, new.user_id, 'wunschliste'
    from public.runs r
    join public.drops d on d.run_id = r.id
    join public.wishlist w on w.user_id = new.user_id and w.item_id = d.item_id
    where r.party_id = new.party_id and r.status = 'offen'
    on conflict do nothing;
  else
    delete from public.interests i
    using public.drops d, public.runs r
    where d.id = i.drop_id and r.id = d.run_id and r.status = 'offen'
      and r.party_id = old.party_id and i.user_id = old.user_id;
  end if;
  return null;
end;
$$;

create trigger wishlist_on_membership
  after insert or delete on public.party_members
  for each row execute function public.wishlist_on_membership();

revoke all on function public.wishlist_on_drop(), public.wishlist_changed(), public.wishlist_on_membership()
  from public, anon, authenticated;
