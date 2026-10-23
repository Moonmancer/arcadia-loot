-- Partys, Runs, Drops, Interessen und Würfeln
--
-- Ablauf: Eine Party macht einen Run. Danach fügt jemand die Guild-Storage-Liste ein
-- (import_drops). Jede Zeile der Liste wird ein Drop. Mitglieder tragen Interesse ein, der
-- Leiter würfelt (roll_run). Die Menge eines Drops wird gleichmäßig auf die Interessenten
-- verteilt, der Rest geht nach Würfelergebnis (bei Menge 1 also an den Höchsten).
-- Nicht stapelbare Items stehen einzeln in der Liste und werden einzeln gewürfelt.
-- Drops ohne Interessenten werden verkauft.

-- Profile (aus Discord-Login befüllt)
create table public.profiles (
  id           uuid primary key references auth.users on delete cascade,
  discord_id   text,
  display_name text not null,
  avatar_url   text,
  created_at   timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, discord_id, display_name, avatar_url)
  values (
    new.id,
    new.raw_user_meta_data ->> 'provider_id',
    coalesce(
      new.raw_user_meta_data -> 'custom_claims' ->> 'global_name',
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      'Unbekannt'
    ),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Partys und Mitglieder
create table public.parties (
  id         bigint generated always as identity primary key,
  name       text not null check (length(trim(name)) > 0),
  created_by uuid not null default auth.uid() references public.profiles,
  created_at timestamptz not null default now()
);

create table public.party_members (
  party_id  bigint not null references public.parties on delete cascade,
  user_id   uuid not null references public.profiles on delete cascade,
  role      text not null default 'member' check (role in ('leader', 'member')),
  joined_at timestamptz not null default now(),
  primary key (party_id, user_id)
);

create index on public.party_members (user_id);

-- Runs (ein Beutezug, eine eingefügte Liste)
create table public.runs (
  id         bigint generated always as identity primary key,
  party_id   bigint not null references public.parties on delete cascade,
  title      text not null check (length(trim(title)) > 0),
  status     text not null default 'offen' check (status in ('offen', 'gewuerfelt')),
  created_by uuid not null default auth.uid() references public.profiles,
  created_at timestamptz not null default now(),
  rolled_at  timestamptz
);

create index on public.runs (party_id);

-- Drops (eine Zeile der Storage-Liste)
create table public.drops (
  id         bigint generated always as identity primary key,
  run_id     bigint not null references public.runs on delete cascade,
  pos        integer not null,          -- Reihenfolge in der Liste
  item_id    integer not null,          -- bewusst kein FK: unbekannte Items sollen den Import nicht blockieren
  name       text not null,             -- Name aus der Liste, inkl. Slots wie "[2]"
  amount     integer not null check (amount > 0),
  attributes text,                      -- null = "[None]"
  cards      text                       -- null = "None"
);

create index on public.drops (run_id);

-- Interessen (inkl. Würfelergebnis und zugeteilter Menge)
create table public.interests (
  drop_id    bigint not null references public.drops on delete cascade,
  user_id    uuid not null default auth.uid() references public.profiles on delete cascade,
  roll       integer check (roll between 1 and 100),
  share      integer check (share >= 0),    -- erhaltene Stückzahl, gesetzt von roll_run
  created_at timestamptz not null default now(),
  primary key (drop_id, user_id)
);

create index on public.interests (user_id);

-- Hilfsfunktionen für RLS (security definer, damit sich die Policies nicht rekursiv aufrufen)
create or replace function public.is_party_member(p_party bigint)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.party_members
                 where party_id = p_party and user_id = auth.uid());
$$;

create or replace function public.is_party_leader(p_party bigint)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.party_members
                 where party_id = p_party and user_id = auth.uid() and role = 'leader');
$$;

-- Darf den Run verwalten: Ersteller des Runs oder Party-Leiter
create or replace function public.can_manage_run(p_run bigint)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.runs r
                 where r.id = p_run
                   and (r.created_by = auth.uid() or public.is_party_leader(r.party_id)));
$$;

-- Ersteller einer Party wird automatisch Leiter
create or replace function public.add_party_creator()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.party_members (party_id, user_id, role) values (new.id, new.created_by, 'leader');
  return new;
end;
$$;

create trigger on_party_created
  after insert on public.parties
  for each row execute function public.add_party_creator();

-- RLS
alter table public.profiles      enable row level security;
alter table public.parties       enable row level security;
alter table public.party_members enable row level security;
alter table public.runs          enable row level security;
alter table public.drops         enable row level security;
alter table public.interests     enable row level security;

create policy "profile lesen"   on public.profiles for select to authenticated using (true);
create policy "profil ändern"   on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy "party lesen"     on public.parties for select to authenticated
  using (public.is_party_member(id) or created_by = auth.uid());
create policy "party anlegen"   on public.parties for insert to authenticated
  with check (created_by = auth.uid());
create policy "party ändern"    on public.parties for update to authenticated
  using (public.is_party_leader(id));
create policy "party löschen"   on public.parties for delete to authenticated
  using (public.is_party_leader(id));

create policy "mitglieder lesen"     on public.party_members for select to authenticated
  using (public.is_party_member(party_id));
create policy "mitglied hinzufügen"  on public.party_members for insert to authenticated
  with check (public.is_party_leader(party_id));
create policy "mitglied ändern"      on public.party_members for update to authenticated
  using (public.is_party_leader(party_id));
create policy "mitglied entfernen"   on public.party_members for delete to authenticated
  using (public.is_party_leader(party_id) or user_id = auth.uid());

create policy "runs lesen"      on public.runs for select to authenticated
  using (public.is_party_member(party_id));
create policy "run anlegen"     on public.runs for insert to authenticated
  with check (public.is_party_member(party_id) and created_by = auth.uid());
create policy "run ändern"      on public.runs for update to authenticated
  using (public.can_manage_run(id));
create policy "run löschen"     on public.runs for delete to authenticated
  using (public.can_manage_run(id));

create policy "drops lesen"     on public.drops for select to authenticated
  using (exists (select 1 from public.runs r where r.id = run_id and public.is_party_member(r.party_id)));
create policy "drop löschen"    on public.drops for delete to authenticated
  using (public.can_manage_run(run_id)
         and exists (select 1 from public.runs r where r.id = run_id and r.status = 'offen'));

create policy "interessen lesen" on public.interests for select to authenticated
  using (exists (select 1 from public.drops d join public.runs r on r.id = d.run_id
                 where d.id = drop_id and public.is_party_member(r.party_id)));
create policy "interesse eintragen" on public.interests for insert to authenticated
  with check (user_id = auth.uid()
              and exists (select 1 from public.drops d join public.runs r on r.id = d.run_id
                          where d.id = drop_id and r.status = 'offen' and public.is_party_member(r.party_id)));
create policy "interesse zurückziehen" on public.interests for delete to authenticated
  using (user_id = auth.uid()
         and exists (select 1 from public.drops d join public.runs r on r.id = d.run_id
                     where d.id = drop_id and r.status = 'offen'));

-- Rechte explizit vergeben (unabhängig von "Automatically expose new tables").
-- Spaltenrechte: Würfelergebnis, Zuteilung und Status setzen nur die Funktionen unten
revoke all on public.profiles, public.parties, public.party_members, public.runs,
              public.drops, public.interests from anon, authenticated;
grant select on public.profiles, public.parties, public.party_members, public.runs,
                public.drops, public.interests to authenticated;
grant delete on public.parties, public.party_members, public.runs,
                public.drops, public.interests to authenticated;
grant select, insert, update, delete on public.profiles, public.parties, public.party_members,
                public.runs, public.drops, public.interests to service_role;
grant insert (name)                  on public.parties       to authenticated;
grant update (name)                  on public.parties       to authenticated;
grant insert (party_id, user_id, role) on public.party_members to authenticated;
grant update (role)                  on public.party_members to authenticated;
grant insert (party_id, title)       on public.runs          to authenticated;
grant update (title)                 on public.runs          to authenticated;
grant insert (drop_id)               on public.interests     to authenticated;
grant update (display_name)          on public.profiles      to authenticated;

-- Storage-Liste importieren. Erwartet das Format aus dem Spiel (tab-getrennt):
--   ID <tab> Name <tab> Amount <tab> Attributes <tab> Cards
-- Kopfzeilen, "Guild Storage" und "Total: ..." werden übersprungen. Gibt die Anzahl Drops zurück.
create or replace function public.import_drops(p_run bigint, p_text text)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  n integer;
  start_pos integer;
begin
  if not public.can_manage_run(p_run) then
    raise exception 'Keine Berechtigung für diesen Run';
  end if;
  if (select status from public.runs where id = p_run) <> 'offen' then
    raise exception 'Run ist bereits gewürfelt';
  end if;

  select coalesce(max(pos), 0) into start_pos from public.drops where run_id = p_run;

  with lines as (
    select line, ord
    from regexp_split_to_table(replace(p_text, E'\r', ''), E'\n') with ordinality as t(line, ord)
    where line ~ E'^\\s*\\d+\\s*\\t'
  ), fields as (
    select ord,
           trim(split_part(line, E'\t', 1))::integer as item_id,
           trim(split_part(line, E'\t', 2))          as name,
           nullif(trim(split_part(line, E'\t', 3)), '') as amount,
           trim(split_part(line, E'\t', 4))          as attributes,
           trim(split_part(line, E'\t', 5))          as cards
    from lines
  )
  insert into public.drops (run_id, pos, item_id, name, amount, attributes, cards)
  select p_run,
         start_pos + row_number() over (order by ord),
         item_id,
         name,
         coalesce(amount::integer, 1),
         nullif(nullif(attributes, '[None]'), ''),
         nullif(nullif(cards, 'None'), '')
  from fields
  where name <> '';

  get diagnostics n = row_count;
  return n;
end;
$$;

-- Würfeln: jeder Interessent bekommt 1–100. Menge / Interessenten geht an alle, der Rest
-- je 1 Stück an die Höchsten (Gleichstand: Zufall). Beispiel: 55 Stück, 3 Interessenten → 19/18/18;
-- 1 Stück → nur der Höchste. Nur einmal pro Run möglich, danach sind Interessen gesperrt.
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
  where d.id = i.drop_id and d.run_id = p_run;

  with ranked as (
    select i.drop_id, i.user_id, d.amount,
           row_number() over (partition by i.drop_id order by i.roll desc, random()) as rank,
           count(*)     over (partition by i.drop_id) as n
    from public.interests i
    join public.drops d on d.id = i.drop_id
    where d.run_id = p_run
  )
  update public.interests i
  set share = r.amount / r.n + case when r.rank <= r.amount % r.n then 1 else 0 end
  from ranked r
  where r.drop_id = i.drop_id and r.user_id = i.user_id;
end;
$$;

revoke all on function public.import_drops(bigint, text), public.roll_run(bigint) from public, anon;
grant execute on function public.import_drops(bigint, text), public.roll_run(bigint) to authenticated;
revoke all on function public.handle_new_user(), public.add_party_creator() from public, anon, authenticated;

-- Übersicht für das Frontend: Drop mit Icon und Marktpreis (RLS der Basistabellen gilt)
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
