# People Sync

React/TypeScript HR workspace with an Express API using Supabase PostgreSQL and Supabase Auth. The active server does not use MongoDB or Neon. Historical MongoDB source and records remain preserved; Neon is used only by the optional one-time import command.

## Run locally

1. Install dependencies with `npm ci --legacy-peer-deps`.
2. Create a Supabase project, preferably in Singapore for the current team. Configure the ignored `.env` with pooled `DATABASE_URL`, direct `DATABASE_URL_UNPOOLED`, `SUPABASE_URL`, `VITE_SUPABASE_URL`, and `VITE_SUPABASE_PUBLISHABLE_KEY`. Employee invitation emails also require `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` (a Gmail App Password for `smtp.gmail.com`), and `EMAIL_FROM`.
3. Enable email confirmation in Supabase Auth. Configure the Confirm signup and Recovery email templates to include `{{ .Token }}` because the application uses six-digit codes. Use production SMTP for reliable account email delivery; do not disable confirmation to work around missing SMTP.
4. Run `npm run db:migrate`, then `npm run dev`.
5. Open http://localhost:5173. Sign up, verify the emailed code, and create a workspace or accept an employee invitation.

Use the hostname matching `APP_URL` (default `http://localhost:5173`). The Supabase URL and publishable key are browser-safe; never place database credentials or a service-role key in browser environment variables. Old MongoDB and Neon passwords are not imported. Do not use the legacy seed script for Supabase accounts.

## Existing Neon data

The source database is not modified. To import it, first apply the Supabase migrations to an empty project and create and verify a Supabase Auth account for every existing Neon user email. Set `NEON_DATABASE_URL` to the old direct Neon connection and run `npm run db:import-legacy`. The command preserves workspace record UUIDs, maps Auth identities by verified email, verifies table counts, and rolls back on failure. It never copies passwords or verification tokens. Remove `NEON_DATABASE_URL` after a successful cutover.

See `supabase/MIGRATION.md` for the hosted cutover checklist.

## Workspace modules

The active API supports shifts, employee profiles, onboarding progress, attendance punches and reports, leave policies and allocations, requests and decisions, projects/tasks, company settings, holidays, roles, audit logs, notifications, and dashboard summaries. Operations validate the authenticated membership, role, workspace boundaries, and input. Writes and related audit events run in transactions.

Employee invitations are emailed through the configured SMTP account with an expiring link. The recipient must authenticate with the verified email on the employee record. If SMTP is missing or rejects the message, the invitation is not saved and the API returns the delivery error. Account verification and password reset are handled by Supabase Auth separately from invitation SMTP.

## Verification

- `npx vitest run tests/supabase-workspace.test.ts tests/supabase-auth.test.ts tests/supabase-schema.test.ts tests/token-cache.test.ts tests/otp.test.ts`: isolated PostgreSQL route, permissions, schema, and authentication tests.
- `npm run build`: TypeScript validation and production bundle.
- `npx tsx scripts/check-workspace.ts`: read-only route smoke checks against the configured database. Prints endpoint statuses only; it does not verify browser sign-in.
- `/api/health`: live database availability.

Older tests exercising MongoDB routes are retained separately and do not establish coverage of the active Supabase server.

## External services and current limits

Private document upload/download routes use an S3-compatible private bucket. Set `S3_BUCKET`, `S3_REGION`, AWS credentials, optionally `S3_ENDPOINT`, and bucket CORS for the app origin. Until configured, uploads are disabled and the UI shows setup status. Storage operations still need end-to-end validation with the configured provider.

Subscription checkout is not connected and is disabled. Billing shows employee estimates and existing payment history; it does not collect payments. Integrations accurately report these states.

Production uses Supabase, `NODE_ENV=production`, an HTTPS `APP_URL`, and a reverse proxy to the API on loopback port 4000. Run `npm run build` then `npm start`. Configure backups and monitoring before production use. Bulk import, multi-workspace selection, advanced reporting, and the remainder of the original specification are not implemented. Browser validation is separate from API tests.
