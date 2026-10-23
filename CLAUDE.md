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

Offen (nächste Schritte):
1. **Loot-Verteilungsregel klären** (würfeln unter Interessenten / Prioritäts- oder Punkteliste /
   alles verkaufen und Zeny teilen). Vor dem Datenmodell für Partys beim Nutzer nachfragen.
2. Schema für Partys, Mitglieder, Drops, Interessen, Zuteilungen + RLS (Mitglieder sehen nur ihre Partys).
3. Frontend in `web/`: Discord-Login, Party-Übersicht, Item-Suche mit Icon und Preis, Interesse eintragen.
4. Discord-Gildenprüfung beim Login.
5. Free-Projekte pausieren nach 7 Tagen Inaktivität – prüfen, ob die Cron-Jobs das verhindern, sonst Keep-alive.

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
```
