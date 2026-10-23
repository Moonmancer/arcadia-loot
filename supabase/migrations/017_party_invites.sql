-- Einladungslinks: Admins und der Ersteller der Party erzeugen einen Link mit zufälligem Token; wer ihn öffnet und angemeldet ist,
-- kann der Party als Teilnehmer beitreten. Links laufen ab (Standard 7 Tage) und lassen sich widerrufen.

create table public.party_invites (
  token      text primary key default replace(gen_random_uuid()::text, '-', ''),
  party_id   bigint not null references public.parties on delete cascade,
  created_by uuid default auth.uid() references public.profiles on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  uses       integer not null default 0
);

create index on public.party_invites (party_id);

-- Darf einladen: Admin der Party oder ihr Ersteller (solange noch Mitglied)
create or replace function public.can_invite(p_party bigint)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select public.is_party_leader(p_party)
      or (public.is_party_member(p_party)
          and exists (select 1 from public.parties where id = p_party and created_by = auth.uid()));
$$;

alter table public.party_invites enable row level security;

-- Nur wer einladen darf, sieht und widerruft die Links der Party; erzeugt wird über create_invite
create policy "einladungen lesen" on public.party_invites for select to authenticated
  using (public.can_invite(party_id));
create policy "einladung widerrufen" on public.party_invites for delete to authenticated
  using (public.can_invite(party_id));

revoke all on public.party_invites from anon, authenticated;
grant select, delete on public.party_invites to authenticated;
grant select, insert, update, delete on public.party_invites to service_role;

create or replace function public.create_invite(p_party bigint, p_days integer default 7)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_token text;
begin
  if not public.can_invite(p_party) then
    raise exception 'Nur Admins und der Ersteller der Party können Einladungen erstellen';
  end if;
  if p_days not between 1 and 90 then
    raise exception 'Gültigkeit muss zwischen 1 und 90 Tagen liegen';
  end if;
  insert into public.party_invites (party_id, expires_at)
  values (p_party, now() + make_interval(days => p_days))
  returning token into v_token;
  return v_token;
end;
$$;

-- Was steckt hinter einem Link? (für die Einladungsseite, jeder angemeldete Nutzer)
create or replace function public.invite_info(p_token text)
returns table (party_id bigint, party_name text, expires_at timestamptz, already_member boolean)
language sql stable security definer set search_path = ''
as $$
  select p.id, p.name, i.expires_at, public.is_party_member(p.id)
  from public.party_invites i
  join public.parties p on p.id = i.party_id
  where i.token = p_token and i.expires_at > now() and auth.uid() is not null;
$$;

create or replace function public.join_party(p_token text)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_party bigint;
begin
  if auth.uid() is null then
    raise exception 'Bitte zuerst anmelden';
  end if;
  select party_id into v_party from public.party_invites
  where token = p_token and expires_at > now();
  if v_party is null then
    raise exception 'Dieser Einladungslink ist ungültig oder abgelaufen';
  end if;
  if not public.is_party_member(v_party) then
    insert into public.party_members (party_id, user_id, role) values (v_party, auth.uid(), 'teilnehmer');
    update public.party_invites set uses = uses + 1 where token = p_token;
  end if;
  return v_party;
end;
$$;

revoke all on function public.create_invite(bigint, integer), public.invite_info(text), public.join_party(text) from public, anon;
grant execute on function public.create_invite(bigint, integer), public.invite_info(text), public.join_party(text) to authenticated;
