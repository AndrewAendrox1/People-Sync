import 'dotenv/config';
import {createHash} from 'node:crypto';
import {readFileSync, readdirSync} from 'node:fs';
import pg from 'pg';

const connectionString = process.env.DATABASE_URL_UNPOOLED;
if (!connectionString) throw new Error('DATABASE_URL_UNPOOLED is required for migrations');
if (new URL(connectionString).hostname.includes('-pooler')) throw new Error('Migrations require a direct database connection');
const client = new pg.Client({connectionString, connectionTimeoutMillis: 15_000});
try {
  await client.connect();
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtext('people-sync-migrations'))");
  await client.query('CREATE SCHEMA IF NOT EXISTS private');
  await client.query('REVOKE ALL ON SCHEMA private FROM PUBLIC');
  await client.query(`CREATE TABLE IF NOT EXISTS private.schema_migrations (
    name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  for (const name of readdirSync('supabase/migrations').filter(n => n.endsWith('.sql')).sort()) {
    const sql = readFileSync(`supabase/migrations/${name}`, 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const existing = await client.query('SELECT checksum FROM private.schema_migrations WHERE name=$1', [name]);
    if (existing.rows.length) {
      if (existing.rows[0].checksum !== checksum) throw new Error(`Applied migration changed: ${name}`);
      console.log(`Already applied: ${name}`);
      continue;
    }
    await client.query(sql);
    await client.query('INSERT INTO private.schema_migrations(name,checksum) VALUES ($1,$2)', [name, checksum]);
    console.log(`Applied: ${name}`);
  }
  await client.query('COMMIT');
  console.log('PostgreSQL migrations committed.');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  // Driver errors can contain connection details; emit only a safe summary.
  console.error(error instanceof Error && error.message.startsWith('Applied migration changed:')
    ? error.message : 'Migration failed and was rolled back. Check database access and SQL constraints.');
  process.exitCode = 1;
} finally {await client.end();}
