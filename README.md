# Arcadia Loot

Loot-Organisation für Ragnarok-Partys auf Arcadia Online – mit aktuellen Marktpreisen.

**Stack:** GitHub Pages (Frontend) · Supabase Free (Datenbank, Auth, Edge Function) · Discord-Login

## Einrichtung (einmalig)

1. Supabase-Projekt anlegen, dann im Repo:
   ```bash
   supabase link --project-ref <ref>
   supabase db push
   supabase secrets set ARCADIA_API_KEY=<dein-key> CRON_SECRET=<langer-zufallswert>
   supabase functions deploy sync-arcadia --no-verify-jwt
   ```
2. Im Supabase SQL-Editor die Vault-Secrets für die Zeitpläne anlegen:
   ```sql
   select vault.create_secret('https://<ref>.supabase.co', 'project_url');
   select vault.create_secret('<gleicher CRON_SECRET wie oben>', 'cron_secret');
   ```
3. Item-Datenbank einmal sofort laden (sonst erst Montag 04:00):
   ```sql
   select public.call_sync_arcadia('items', 60000);
   ```
4. GitHub: *Settings → Pages → Source: GitHub Actions*.
5. Discord-Login: in Supabase *Authentication → Providers → Discord* aktivieren
   (Client-ID/Secret aus dem Discord Developer Portal).

Weitere Infos für die Entwicklung mit Claude Code: `CLAUDE.md`.
