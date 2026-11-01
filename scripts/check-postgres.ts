import 'dotenv/config';
import {databasePool, closeDatabase, withDatabaseIdentity} from '../server/database';

try {
  const pool = databasePool();
  const migrations = await pool.query('SELECT name FROM private.schema_migrations ORDER BY name');
  console.log('Applied migrations:', migrations.rows.map(row => row.name).join(', '));
  const tables = await pool.query("SELECT count(*)::int AS total FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'");
  console.log('Application tables:', tables.rows[0].total);
  const unprotected = await pool.query("SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity");
  if (unprotected.rows.length) throw new Error('Application tables without RLS');
  await withDatabaseIdentity('00000000-0000-0000-0000-000000000000', async client => {
    const rows = await client.query('SELECT id FROM public.organizations');
    if (rows.rowCount) throw new Error('Unrecognized identity can read organizations');
    const privileges = await client.query("SELECT has_table_privilege(current_user,'public.organizations','INSERT') AS can_insert, has_table_privilege(current_user,'private.workspace_invitations','SELECT') AS can_read_identity");
    if (privileges.rows[0].can_insert || privileges.rows[0].can_read_identity) throw new Error('Excessive application privileges');
  });
  console.log('Supabase connection and restricted-role checks passed.');
} catch {
  console.error('Supabase verification failed. No credentials have been printed.');
  process.exitCode = 1;
} finally {await closeDatabase();}
