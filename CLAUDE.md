# Arcadia Loot – Projektkontext für Claude

Webseite zur Loot-Organisation für Ragnarok-Online-Partys auf dem Server **Arcadia Online**.
Spieler tragen ein, welches Item sie interessiert; die Seite zeigt aktuelle Marktpreise.
Mehrere Partys parallel. Nicht-kommerzielles Gilden-Tool.

Kommunikation mit dem Nutzer auf Deutsch. Ergebnisse liefern, keine langen Schritt-Erklärungen.

## Architektur (entschieden)

| Teil | Technik | Ort |
|---|---|---|
| Frontend | statisch (HTML/JS), gehostet auf **GitHub Pages** (Free, öffentliches Repo) | `web/` |
| Datenbank + Auth | **Supabase** Free (Postgres, RLS, Auth) | `supabase/migrations/` |
| Login / Zugriff | **Discord OAuth** über Supabase Auth; später nur Mitglieder des Gilden-Discords (Scope `guilds`) | – |
| Preisabruf | Supabase **Edge Function** `sync-arcadia`, per pg_cron ausgelöst | `supabase/functions/sync-arcadia/` |
| Deploy Frontend | GitHub Actions → Pages | `.github/workflows/pages.yml` |

## Harte Regeln

- **Der Browser ruft die Arcadia-API nie direkt auf.** Der API-Key ist an den Master-Account gebunden und darf
  nicht öffentlich werden (Repo ist öffentlich). Er liegt nur als Supabase-Secret `ARCADIA_API_KEY`.
- **Rate-Limits der Arcadia-API gelten pro IP** (Edge Functions teilen IPs). Bei Missbrauch sperrt die API IP/Key.
  Daher: keine Abrufe pro Seitenbesuch, keine Retries bei 429, Zeitpläne nicht verdichten.
  Details in `docs/arcadia-api.md`.
- Frontend liest Preise/Items ausschließlich aus Supabase-Tabellen.
- Schreibzugriff auf `items`, `item_prices`, `price_history` nur über Service Role (Edge Function / Cron).
- Keine Secrets im Repo. Supabase-URL und **anon key** im Frontend sind ok (durch RLS geschützt).
- GitHub Pages: keine Passwortformulare, kein Zahlungs-/Shopkram; Login nur über Discord.

## Stand

Fertig:
- Schema `items`, `item_prices`, `price_history` inkl. RLS (Lesen nur für `authenticated`).
- Edge Function `sync-arcadia`: `?mode=market` (alle 15 min) und `?mode=items` (wöchentlich, Items + Icons).
- Preislogik: nur „normale" Items (kein Refine, keine Karten, nicht geschmiedet, keine benannten Pets).
  Verkauf → `sell_min`, `sell_median`; Ankauf → `buy_max`. Sell/Buy getrennt upserten, damit der letzte
  bekannte Wert erhalten bleibt. Täglicher Snapshot in `price_history`, 180 Tage.
- pg_cron-Jobs holen URL und Secret aus Supabase Vault (`project_url`, `cron_secret`).
- **Loot-Regel (entschieden): Würfeln unter Interessenten.** Menge wird gleichmäßig auf die
  Interessenten aufgeteilt, der Rest geht stückweise an die höchsten Würfe (55 auf 3 → 19/18/18;
  Menge 1 → Höchster). Drops ohne Interessenten werden verkauft.
- Schema `002_parties_loot.sql`: `profiles` (Trigger aus Discord-Metadaten), `parties`, `party_members`
  (Ersteller wird `leader`), `runs` (`offen` → `gewuerfelt`), `drops`, `interests` (inkl. `roll`, `share`),
  View `drop_overview` (Drop + Icon + Preis + `is_plain` + Interessentenzahl, `security_invoker`).
  RLS: Mitglieder sehen nur ihre Partys. Würfelwerte, Zuteilung, Status nur über RPCs (Spaltenrechte).
- RPC `import_drops(run, text)`: nimmt die eingefügte Guild-Storage-Liste (tab-getrennt:
  ID, Name, Amount, Attributes, Cards). Eine Zeile = ein Drop; nicht stapelbare Items stehen
  mehrfach in der Liste und werden einzeln gewürfelt.
  Name behält Slots wie „[4]". Attribute/Karten ≠ None → `is_plain = false` (Marktpreis passt nicht).
- RPC `roll_run(run)`: nur Run-Ersteller oder Party-Leiter, einmalig; 1–100 pro Interessent,
  setzt `interests.share` nach obiger Regel, Gleichstand per Zufall.
- Schema `003_wishlist.sql`: `wishlist` (pro Nutzer, nur selbst sichtbar, FK auf `items`).
  Trigger tragen den Nutzer in allen seinen Partys bei passenden Drops **offener** Runs als Interessent
  ein (`interests.source = 'wunschliste'`): bei Import, neuem Wunsch, Party-Beitritt. Wunsch entfernen
  bzw. Party verlassen entfernt die Interessen wieder (nur offene Runs; manuelle Interessen beim
  Entfernen eines Wunsches bleiben). Abgleich nur über Item-ID, Refine/Karten egal.
- Schema `004_roles_sales.sql`: Rollen `admin` / `verkaeufer` / `teilnehmer` (Funktion heißt weiter
  `is_party_leader`, bedeutet „Admin"; `is_party_seller` = Admin oder Verkäufer). Mehrere Admins,
  letzter Admin geschützt (Trigger). `parties.party_price_pct` (Standard 75). `drops.price_override`
  (Stückpreis, RPC `set_price`, nur Admin), `drops.assigned_to` (RPC `assign_drop`, nur Admin; wird
  nicht gewürfelt, `interests.source = 'zuweisung'`), `drops.sold_price` (RPC `set_sale`, Admin/Verkäufer,
  nur gewürfelte Drops ohne Interessenten).
- **Abrechnung (wie früher im Google Doc):** Empfänger zahlt Partypreis = Stückpreis × Anteil × pct % in
  die Kasse; Kasse + Verkaufserlöse ÷ alle Party-Mitglieder; Saldo = erhält − zahlt. Berechnung im
  Frontend. Stückpreis = Override, sonst Marktpreis (Median, sonst Min) nur bei normalen Items.
- Schema `005_run_workflow.sql` + `006_rest_per_drop.sql`: Run-Phasen `offen` → `abholung` → `verkauf` →
  `auszahlung` → `beendet` (RPC `set_run_status`, je ein Schritt, nicht zurück nach `offen`; Würfeln
  wechselt nach `abholung`). `run_participants` (beim Anlegen alle Mitglieder, in `offen` vom Verwalter
  änderbar; nur Teilnehmer: Interesse, Zuweisung, Rest, Kassenanteil; `paid_at` via `set_paid`, nur
  Admin/Verkäufer). `interests.picked_up_at` via `set_picked_up` (selbst oder Admin/Verkäufer).
  Rest: `split_rest` – jeder Drop komplett an einen Teilnehmer, reihum; wer im Run weniger Rest hat zuerst, sonst Zufall (007),
  gratis (`source = 'rest'`, kein Partypreis); `undo_rest` solange nicht abgeholt.
- **PostgREST:** `interests` und `run_participants` haben je zwei FKs auf `profiles` → Embedding mit
  Hinweis, z. B. `profiles!interests_user_id_fkey(display_name)`.
- NPC-Preis: `items.npc_price` = NPC-Einkaufspreis (API `/items/list`). Verkauf an NPC im Frontend =
  floor(floor(npc_price / 2) × 1,24) (Verkäufer hat Overcharge 10). Spalte „NPC“ in Loot-Liste und
  Wunschliste; Ersatz-Stückpreis, wenn kein Override und kein Marktpreis (bzw. Item mit Attr./Karten).
  `drop_overview` hat dafür `npc_price` (008).
- An NPC verkaufen (009): RPC `sell_to_npc(drop)` setzt `sold_price` = Menge × NPC-Verkaufspreis
  (gleiche Formel serverseitig) und `drops.sold_to_npc`; manueller Erlös/Zuweisung hebt die Markierung auf.
  Frontend: Knopf „NPC“ pro übrigem Drop und „Alle an NPC“ in der Phase Verkauf & Rest.
- Migrationen lokal mit PGlite getestet (Auth-Stubs).
- **Live:** Supabase-Projekt `puddakqxselbytszbzhw` (Frankfurt), Migrationen 001–009 eingespielt,
  `sync-arcadia` deployt, Secrets + Vault gesetzt, Items/Icons/Preise geladen, Cron-Jobs aktiv.
  GitHub-Repo `Moonmancer/arcadia-loot` (öffentlich); Pages aktiv (Source: GitHub Actions).

- Frontend `web/` (statisch, ES-Module, supabase-js 2.45.4 von jsdelivr, kein Build):
  `config.js` (URL + publishable key), `app.js` (Hash-Routing `#/`, `#/party/:id`, `#/run/:id`,
  `#/wunschliste`; Login per Discord mit PKCE), `style.css`. DOM nur über `h()`/textContent.
  Leiter fügt Mitglieder per Profilsuche (Discord-Name) hinzu. Lokal: `.claude/launch.json` → Server
  `web` auf Port 5500. Ansichten mit gemockten Daten getestet, echter Login noch nicht.

Offen (nächste Schritte):
1. Discord-Provider in Supabase aktivieren; *Authentication → URL Configuration*: Site URL
   `https://moonmancer.github.io/arcadia-loot/`, Redirect URLs zusätzlich `http://localhost:5500/`.
2. Echten Login-Durchlauf testen (Pages ist live: https://moonmancer.github.io/arcadia-loot/).
3. Discord-Gildenprüfung beim Login.
4. Free-Projekte pausieren nach 7 Tagen Inaktivität – prüfen, ob die Cron-Jobs das verhindern, sonst Keep-alive.

## Bekannte API-Eigenheiten

- `/items/icons`: Doku nennt das Feld `icons`, Beispiel zeigt `items` → Code akzeptiert beides.
- `/fame/list`: Doku nennt das Feld `id`, Beispiel zeigt `char_id`.
- Es gibt keinen Preis-Endpunkt; Preise werden aus `/market/list` (offene Shops) berechnet.

## Befehle

```bash
supabase link --project-ref <ref>
supabase db push
supabase secrets set ARCADIA_API_KEY=... CRON_SECRET=...
supabase functions deploy sync-arcadia --no-verify-jwt
supabase functions serve sync-arcadia --env-file supabase/functions/.env   # lokal
supabase db query --linked "select ..."   # SQL gegen das Live-Projekt
```

Windows/PowerShell: `npx.cmd supabase@2 ...` statt `supabase` (keine globale Installation, Execution Policy).
Deploy ohne Docker: `supabase functions deploy sync-arcadia --no-verify-jwt --use-api`.
