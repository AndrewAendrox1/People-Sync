import 'dotenv/config';
import pg from 'pg';

let pool: pg.Pool | undefined;

export function databasePool(): pg.Pool {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for Supabase PostgreSQL');
  return pool ??= new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    // Keep sockets alive to avoid repeated public-internet TLS handshakes.
    idleTimeoutMillis: 300_000,
    connectionTimeoutMillis: 15_000,
    keepAlive: true,
  });
}

// A caller must authenticate the provider session before passing its user ID.
// SET LOCAL and the dedicated role ensure identity never leaks between requests.
export async function withDatabaseIdentity<T>(userId: string, run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  if (!userId.trim()) throw new Error('An authenticated identity is required');
  const client = await databasePool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE authenticated');
    await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [userId]);
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {client.release();}
}

export async function closeDatabase() {
  if (pool) {await pool.end(); pool = undefined;}
}
