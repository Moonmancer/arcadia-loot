# Arcadia Online API – Kurzreferenz

Vollständige Doku: https://gitlab.com/arcadia-online/arcadia-online/-/tree/master/doc/api

- Basis-URL: `https://api.arcadia-online.org/api/v1`
- Auth: Header `x-api-key: <key>` (alternativ Query `api_key`, hier **nicht** verwenden – landet in Logs).
  Key wird im Control Panel des Master-Accounts erzeugt/widerrufen.
- Fehler: 401 ohne/mit falschem Key, 429 bei Rate-Limit (Header `Retry-After`, `X-RateLimit-*`),
  403 auf alles = IP/Key gesperrt → Arcadia-Support kontaktieren.
- Rate-Limits gelten **pro IP-Adresse**.

| Endpunkt | Auth | Limit | Empfehlung der API | Nutzung hier |
|---|---|---|---|---|
| `/ping` | nein | 2 / 10 s | – | Verfügbarkeitstest |
| `/whoami` | ja | 2 / 10 s | – | Key-Test |
| `/items/list` | ja | 6 / Tag | ≥ 7 Tage cachen | wöchentlich |
| `/items/icons` | ja | 6 / Tag | ≥ 7 Tage cachen | wöchentlich |
| `/market/list` | ja | 12 / Stunde | serverseitig ~10 min gecacht | alle 15 min |
| `/fame/list` | ja | 12 / Stunde | serverseitig ~10 min gecacht | derzeit nicht genutzt |

## Relevante Felder

`/items/list` → `items[]`: `item_id`, `unique_name`, `name`, `type` (`IT_WEAPON`, `IT_CARD`, …),
`subtype` (nur Waffen/Munition), `npc_price`, `slots` (optional).

`/items/icons` → Liste mit `item_id`, `icon` (data-URI PNG).

`/market/list` → `shops[]`: `title`, `owner`, `location{map,x,y}`, `creation_date`,
`type` (`V` = Verkauf, `B` = Ankauf), `items[]` mit `item_id`, `amount`, `price` (Zeny) und optional
`refine`, `cards[]`, `star_crumbs`, `element`, `creator`, `beloved`.

`/fame/list` → `brewers[]`, `forgers[]` mit ID (vgl. `creator` im Markt), `name`, `points`.
