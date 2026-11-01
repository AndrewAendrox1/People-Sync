import {readFileSync, readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {afterAll, beforeAll, expect, it} from 'vitest';

const db = new PGlite();
const workspaceA = '10000000-0000-4000-8000-000000000001';
const workspaceB = '10000000-0000-4000-8000-000000000002';
const owner = '20000000-0000-4000-8000-000000000001';
const employee = '30000000-0000-4000-8000-000000000001';

beforeAll(async () => {
  // Minimal Supabase platform contract; no production account or credentials.
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to authenticated;
    grant execute on function auth.uid() to authenticated;
  `);
  for (const name of readdirSync('supabase/migrations').filter(n => n.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(`supabase/migrations/${name}`, 'utf8'));
  }
  await db.query('insert into auth.users values ($1)', [owner]);
  await db.query("insert into public.organizations(id,name,code) values ($1,'Workspace A','AAA'),($2,'Workspace B','BBB')", [workspaceA, workspaceB]);
  await db.query("insert into public.memberships(organization_id,user_id,role) values ($1,$2,'owner')", [workspaceA, owner]);
  await db.query("insert into public.employees(id,organization_id,employee_code,name,email) values ($1,$2,'EMP-1','Test employee','test@example.invalid')", [employee, workspaceA]);
});
afterAll(async () => {await db.close();});

it('rejects cross-workspace project membership', async () => {
  const result = await db.query<{id: string}>("insert into public.projects(organization_id,name) values ($1,'Project B') returning id", [workspaceB]);
  await expect(db.query('insert into public.project_members values ($1,$2,$3)', [workspaceB, result.rows[0].id, employee])).rejects.toThrow(/foreign key/i);
});

it('limits an owner to their workspace and rejects direct writes', async () => {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
  await db.exec('set role authenticated');
  try {
    const result = await db.query<{id: string}>('select id from public.organizations');
    expect(result.rows).toEqual([{id: workspaceA}]);
    expect((await db.query('select * from public.projects')).rows).toEqual([]);
    await expect(db.query("insert into public.projects(organization_id,name) values ($1,'Unauthorized')", [workspaceA])).rejects.toThrow(/permission denied/i);
    await expect(db.query('select * from private.employee_sensitive')).rejects.toThrow(/permission denied/i);
  } finally {await db.exec('reset role');}
});

it('blocks anonymous access', async () => {
  await db.exec('set role anon');
  try {
    await expect(db.query('select * from public.employees')).rejects.toThrow(/permission denied/i);
  } finally {await db.exec('reset role');}
});

it('enforces document paths belonging to the employee and workspace', async () => {
  await expect(db.query("insert into public.documents(organization_id,employee_id,name,storage_path,mime_type,size_bytes) values ($1,$2,'Test','wrong/path/file.pdf','application/pdf',1)", [workspaceA, employee])).rejects.toThrow(/check constraint/i);
});

it('enables RLS on every application table', async () => {
  const result = await db.query("select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind='r' and not c.relrowsecurity");
  expect(result.rows).toEqual([]);
});
