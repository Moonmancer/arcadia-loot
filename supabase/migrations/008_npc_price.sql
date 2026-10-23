-- NPC-Preis in der Drop-Übersicht. items.npc_price ist der NPC-Einkaufspreis; beim Verkauf an den NPC
-- gibt es die Hälfte, mit Overcharge (Stufe 10) 24 % mehr. Die Umrechnung macht das Frontend.

create or replace view public.drop_overview
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
