-- Keep-alive: GitHub Actions ruft alle 3 Tage public.ping() mit dem öffentlichen Schlüssel auf, damit das
-- Free-Projekt nicht wegen Inaktivität pausiert. Gibt nur die Serverzeit zurück, liest keine Daten.

create or replace function public.ping()
returns timestamptz
language sql stable
set search_path = ''
as $$
  select now();
$$;

revoke all on function public.ping() from public;
grant execute on function public.ping() to anon, authenticated;
