# People Sync: Supabase cutover

Target: Supabase PostgreSQL and Supabase Auth. The four files in `supabase/migrations/` are the only active application schema migrations. The older Neon SQL has been removed. Neon remains preserved as a read-only rollback/audit source.

Status: the hosted Singapore project is running with all four migrations, verified RLS/grants, both legacy Auth identities, and all imported workspace records count-verified. Owner login, the imported Employee Directory, and all 20 workspace route smoke checks pass. Custom SMTP credentials are still required to edit the Confirm signup and Recovery templates for six-digit codes and to deliver employee invitations; those email flows remain unverified. Local PGlite tests validate PostgreSQL constraints and RLS, not hosted email delivery.

## Cutover sequence

1. Create the People Sync project in the intended Supabase organization. Singapore is the preferred region for the current team. Keep the existing Neon project intact during migration.
2. Copy the pooled and direct PostgreSQL connection strings into server-only `DATABASE_URL` and `DATABASE_URL_UNPOOLED`. Set `SUPABASE_URL` and the browser-safe `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. Never expose a service-role key through a `VITE_` variable.
3. Enable email confirmation. Update Confirm signup and Recovery templates to include `{{ .Token }}` for the six-digit code forms. Add the local/production Auth redirect URLs. Configure production SMTP for dependable delivery; do not disable email confirmation as an SMTP workaround.
4. Run `npm run db:migrate`. The migrations create the workspace tables, UUID foreign keys to `auth.users`, tenant-safe composite relationships, private invitation/sensitive-data tables, and fail-closed RLS/grants. Run `npm run db:check` afterward.
5. Create and verify Supabase Auth accounts for each existing Neon Auth email. The application does not copy passwords or mark unverified accounts verified. Set `NEON_DATABASE_URL` to the old direct source connection and run `npm run db:import-legacy` against the empty Supabase target. The transaction preserves record UUIDs, maps user IDs by verified email, restores employee managers, and verifies table counts.
6. Run the schema/Auth/workspace test suites, production build, `scripts/check-workspace.ts`, and authenticated browser checks. Exercise signup, verification, login/logout, password reset, workspace creation, invitation delivery/acceptance, attendance punches, leave reservations/approvals, and tenant isolation.
7. Only after those checks pass, deploy the Supabase configuration and remove `NEON_DATABASE_URL`. Keep the old Neon data read-only for a rollback/audit period before any separate deletion decision.

## Security notes

- API roles come from trusted `memberships`, never editable Auth user metadata. Metadata is used only for display names.
- The Express API verifies Supabase access tokens against the project JWKS with issuer, audience, and asymmetric algorithm checks, then confirms the user and email verification state in `auth.users`.
- Public-schema RLS uses `auth.uid()` and trusted memberships. Direct writes are denied; private invitation and sensitive tables have no browser-role grants. The server still applies organization and role checks to every route.
- Invitation tokens remain SHA-256 hashes at rest. Employee invitation delivery uses application SMTP and is independent of Supabase Auth email delivery.
