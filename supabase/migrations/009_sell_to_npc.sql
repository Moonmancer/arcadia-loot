-- Drop an NPC verkaufen: Erlös = Menge × NPC-Verkaufspreis. NPC-Verkaufspreis = halber npc_price
-- (NPC-Einkaufspreis) + 24 % Overcharge, jeweils abgerundet – gleiche Formel wie npcSell() im Frontend.

alter table public.drops add column sold_to_npc boolean not null default false;

create or replace function public.sell_to_npc(p_drop bigint)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_party bigint;
  v_status text;
  v_amount integer;
  v_npc integer;
  v_price bigint;
begin
  select r.party_id, r.status, d.amount, i.npc_price into v_party, v_status, v_amount, v_npc
  from public.drops d
  join public.runs r on r.id = d.run_id
  left join public.items i on i.item_id = d.item_id
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
  if coalesce(v_npc, 0) <= 0 then
    raise exception 'Für dieses Item ist kein NPC-Preis bekannt';
  end if;

  v_price := v_amount::bigint * floor(floor(v_npc / 2.0) * 124 / 100)::bigint;
  update public.drops
  set sold_price = v_price, sold_to_npc = true, sold_by = auth.uid(), sold_at = now()
  where id = p_drop;
  return v_price;
end;
$$;

revoke all on function public.sell_to_npc(bigint) from public, anon;
grant execute on function public.sell_to_npc(bigint) to authenticated;

-- Manuell erfasster Erlös hebt die NPC-Markierung auf
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
  set sold_price  = p_price,
      sold_to_npc = false,
      sold_by     = case when p_price is null then null else auth.uid() end,
      sold_at     = case when p_price is null then null else now() end
  where id = p_drop;
end;
$$;

-- Fällt der Erlös weg (zurückgenommen oder durch Zuweisung verworfen), fällt auch die NPC-Markierung weg
create or replace function public.clear_npc_flag()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.sold_price is null then
    new.sold_to_npc := false;
  end if;
  return new;
end;
$$;

create trigger clear_npc_flag
  before update of sold_price on public.drops
  for each row execute function public.clear_npc_flag();

-- View neu anlegen, damit sold_to_npc enthalten ist (d.* wird beim Anlegen festgeschrieben)
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
       (select count(*) from public.interests x where x.drop_id = d.id) as interest_count,
       i.npc_price
from public.drops d
join public.runs r on r.id = d.run_id
left join public.items i on i.item_id = d.item_id
left join public.item_prices p on p.item_id = d.item_id;

revoke all on public.drop_overview from anon, authenticated;
grant select on public.drop_overview to authenticated, service_role;
