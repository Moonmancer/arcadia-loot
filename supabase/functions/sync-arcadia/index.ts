// Holt Markt- und Itemdaten von der Arcadia-API und speichert sie in Supabase.
// Aufruf nur per Zeitplan (pg_cron) mit Header x-cron-secret.
//   ?mode=market  -> aktuelle Preise (max. 12 Aufrufe/Stunde laut API)
//   ?mode=items   -> Itemdatenbank + Icons (max. 6 Aufrufe/Tag laut API)

import { createClient } from "jsr:@supabase/supabase-js@2";

const API = "https://api.arcadia-online.org/api/v1";
const API_KEY = Deno.env.get("ARCADIA_API_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET")!;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

class RateLimited extends Error {
  constructor(public retryAfter: string | null) {
    super("rate limited");
  }
}

async function arcadia(path: string) {
  const res = await fetch(`${API}${path}`, { headers: { "x-api-key": API_KEY } });
  // Limit gilt pro IP: nicht erneut versuchen, der nächste Zeitplan-Lauf holt es nach.
  if (res.status === 429) throw new RateLimited(res.headers.get("Retry-After"));
  if (!res.ok) throw new Error(`Arcadia ${path}: ${res.status} ${await res.text()}`);
  return await res.json();
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

async function upsert(table: string, rows: Record<string, unknown>[], onConflict: string) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from(table).upsert(rows.slice(i, i + 500), { onConflict });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

async function syncMarket() {
  const data = await arcadia("/market/list");
  const sell = new Map<number, { prices: number[]; amount: number }>();
  const buy = new Map<number, number[]>();

  for (const shop of data.shops ?? []) {
    for (const it of shop.items ?? []) {
      // Nur "normale" Items: kein Refine, keine Karten, nicht geschmiedet, keine benannten Pets
      if (it.refine || it.cards?.length || it.star_crumbs || it.element || it.beloved) continue;

      if (shop.type === "V") {
        const e = sell.get(it.item_id) ?? { prices: [], amount: 0 };
        e.prices.push(it.price);
        e.amount += it.amount;
        sell.set(it.item_id, e);
      } else if (shop.type === "B") {
        const e = buy.get(it.item_id) ?? [];
        e.push(it.price);
        buy.set(it.item_id, e);
      }
    }
  }

  const now = new Date().toISOString();

  // Getrennte Upserts: so bleibt der letzte bekannte Verkaufspreis erhalten,
  // wenn ein Item gerade nur in Ankaufshops auftaucht (und umgekehrt).
  await upsert("item_prices", [...sell].map(([item_id, e]) => ({
    item_id,
    sell_min: Math.min(...e.prices),
    sell_median: median(e.prices),
    sell_listings: e.prices.length,
    sell_amount: e.amount,
    sell_seen_at: now,
  })), "item_id");

  await upsert("item_prices", [...buy].map(([item_id, prices]) => ({
    item_id,
    buy_max: Math.max(...prices),
    buy_listings: prices.length,
    buy_seen_at: now,
  })), "item_id");

  return { shops: data.shops?.length ?? 0, sellItems: sell.size, buyItems: buy.size };
}

async function syncItems() {
  const [db, ic] = await Promise.all([arcadia("/items/list"), arcadia("/items/icons")]);

  // Die Doku nennt das Feld "icons", das Beispiel zeigt "items" – beides abfangen.
  const iconList: { item_id: number; icon: string }[] = ic.icons ?? ic.items ?? [];
  const icons = new Map(iconList.map((x) => [x.item_id, x.icon]));
  const now = new Date().toISOString();

  const rows = (db.items ?? []).map((it: Record<string, unknown>) => ({
    item_id: it.item_id,
    unique_name: it.unique_name,
    name: it.name,
    type: it.type,
    subtype: it.subtype ?? null,
    npc_price: it.npc_price ?? null,
    slots: it.slots ?? null,
    icon: icons.get(it.item_id as number) ?? null,
    updated_at: now,
  }));

  await upsert("items", rows, "item_id");
  return { items: rows.length, icons: icons.size };
}

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  const mode = new URL(req.url).searchParams.get("mode");
  try {
    if (mode === "market") return Response.json(await syncMarket());
    if (mode === "items") return Response.json(await syncItems());
    return new Response("unknown mode", { status: 400 });
  } catch (e) {
    if (e instanceof RateLimited) {
      console.warn(`Arcadia rate limit, Retry-After: ${e.retryAfter}s – übersprungen`);
      return Response.json({ skipped: "rate_limited", retryAfter: e.retryAfter });
    }
    console.error(e);
    return new Response(String(e), { status: 500 });
  }
});
