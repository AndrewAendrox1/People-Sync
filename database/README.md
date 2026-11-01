# People Sync database

The active schema is Supabase PostgreSQL. Apply and track the SQL files in `../supabase/migrations/` with `npm run db:migrate`; do not edit migrations after applying them.

Use `npm run db:check` for connection and restricted-role checks. The optional `npm run db:import-legacy` command copies existing Neon workspace records into an empty Supabase target after matching verified Auth accounts exist. It does not run during normal application startup and never copies passwords.

The full hosted cutover and verification checklist is in `../supabase/MIGRATION.md`.
