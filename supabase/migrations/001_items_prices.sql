-- Items, aktuelle Preise und täglicher Preisverlauf aus der Arcadia-API

create table public.items (
  item_id     integer primary key,
  unique_name text not null,
  name        text not null,
  type        text not null,
  subtype     text,
  npc_price   integer,
  slots       integer,
  icon        text,               -- data:image/png;base64,...
  updated_at  timestamptz not null default now()
);

create table public.item_prices (
  item_id       integer primary key,
  sell_min      bigint,           -- günstigstes Verkaufsangebot (Zeny)
  sell_median   bigint,           -- Median der Verkaufsangebote
  sell_listings integer,          -- Anzahl Angebote
  sell_amount   integer,          -- Stückzahl insgesamt
  sell_seen_at  timestamptz,      -- zuletzt im Markt gesehen
  buy_max       bigint,           -- höchstes Ankaufsgebot
  buy_listings  integer,
  buy_seen_at   timestamptz
);

create table public.price_history (
  item_id     integer not null,
  day         date not null default current_date,
  sell_min    bigint,
  sell_median bigint,
  buy_max     bigint,
  primary key (item_id, day)
);

-- Lesen nur für eingeloggte Nutzer, Schreiben nur über die Edge Function (Service Role)
alter table public.items         enable row level security;
alter table public.item_prices   enable row level security;
alter table public.price_history enable row level security;

create policy "items lesen"   on public.items         for select to authenticated using (true);
create policy "preise lesen"  on public.item_prices   for select to authenticated using (true);
create policy "verlauf lesen" on public.price_history for select to authenticated using (true);

-- Rechte explizit vergeben (unabhängig von "Automatically expose new tables")
revoke all on public.items, public.item_prices, public.price_history from anon, authenticated;
grant select on public.items, public.item_prices, public.price_history to authenticated;
grant select, insert, update, delete on public.items, public.item_prices, public.price_history to service_role;

-- Zeitpläne
-- URL und Secret kommen aus Supabase Vault (Secrets "project_url" und "cron_secret"),
-- damit diese Migration keine Platzhalter braucht. Einmalig anlegen, siehe README.
create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.call_sync_arcadia(mode text, timeout_ms int default 5000)
returns void
language sql
security definer
set search_path = ''
as $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
           || '/functions/v1/sync-arcadia?mode=' || mode,
    headers := jsonb_build_object(
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    timeout_milliseconds := timeout_ms
  );
$$;

revoke all on function public.call_sync_arcadia(text, int) from public, anon, authenticated;

select cron.schedule('arcadia-market', '*/15 * * * *', $$ select public.call_sync_arcadia('market'); $$);
select cron.schedule('arcadia-items',  '0 4 * * 1',    $$ select public.call_sync_arcadia('items', 60000); $$);

-- Täglicher Snapshot in den Verlauf, Verlauf auf 180 Tage begrenzt
select cron.schedule('arcadia-history', '55 23 * * *', $$
  insert into public.price_history (item_id, day, sell_min, sell_median, buy_max)
  select item_id, current_date, sell_min, sell_median, buy_max
  from public.item_prices
  where sell_seen_at > now() - interval '1 day' or buy_seen_at > now() - interval '1 day'
  on conflict (item_id, day) do update
    set sell_min = excluded.sell_min, sell_median = excluded.sell_median, buy_max = excluded.buy_max;
  delete from public.price_history where day < current_date - 180;
$$);
