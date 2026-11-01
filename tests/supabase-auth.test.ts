import {beforeEach,expect,it,vi} from 'vitest';
import request from 'supertest';
const mocks=vi.hoisted(()=>({jwt:vi.fn(),query:vi.fn(),transaction:vi.fn(),release:vi.fn()}));
vi.mock('jose',()=>({createRemoteJWKSet:()=>({}),jwtVerify:mocks.jwt}));
vi.mock('../server/database',()=>({databasePool:()=>({query:mocks.query,connect:async()=>({query:mocks.transaction,release:mocks.release})})}));
import {verifyIdentity} from '../server/supabase-auth';
import {supabaseApp} from '../server/supabase-app';
const subject='20000000-0000-4000-8000-000000000001';
beforeEach(()=>{
  vi.clearAllMocks();
  process.env.SUPABASE_URL='https://project.example.supabase.co';
  mocks.jwt.mockResolvedValue({payload:{sub:subject}});
  mocks.query.mockResolvedValue({rows:[{id:subject,name:'Test User',email:'test@example.invalid',emailVerified:true}]});
});
it('rejects missing and forged credentials before accessing records',async()=>{
  await expect(verifyIdentity()).rejects.toMatchObject({status:401});
  mocks.jwt.mockRejectedValue(new Error('bad signature'));
  await expect(verifyIdentity('Bearer forged')).rejects.toMatchObject({status:401});
  expect(mocks.query).not.toHaveBeenCalled();
});
it('verifies issuer, audience and algorithm and denies unverified identities',async()=>{
  mocks.query.mockResolvedValue({rows:[{id:subject,emailVerified:false}]});
  await expect(verifyIdentity('Bearer test')).rejects.toMatchObject({status:403});
  expect(mocks.jwt).toHaveBeenCalledWith('test',expect.anything(),{issuer:'https://project.example.supabase.co/auth/v1',audience:'authenticated',algorithms:['ES256','RS256']});
});
it('does not accept client-provided owner roles without authentication',async()=>{
  const result=await request(supabaseApp).post('/api/v1/auth/workspace').set('X-Requested-With','PeopleSync').send({company:'Test',code:'TEST',terms:true,role:'owner'});
  expect(result.status).toBe(401);expect(mocks.transaction).not.toHaveBeenCalled();
});
it('requires terms and a valid workspace code',async()=>{
  const result=await request(supabaseApp).post('/api/v1/auth/workspace').set('X-Requested-With','PeopleSync').set('Authorization','Bearer test').send({company:'Test',code:'1.1.1',terms:false});
  expect(result.status).toBe(400);expect(mocks.transaction).not.toHaveBeenCalled();
});
it('rolls back duplicate membership rather than creating another owner workspace',async()=>{
  mocks.transaction.mockImplementation(async(sql:string)=>sql.startsWith('SELECT id FROM public.memberships')?{rowCount:1,rows:[{id:'existing'}]}:{rows:[]});
  const result=await request(supabaseApp).post('/api/v1/auth/workspace').set('X-Requested-With','PeopleSync').set('Authorization','Bearer test').send({company:'Test',code:'TEST',terms:true});
  expect(result.status).toBe(409);
  expect(mocks.transaction).toHaveBeenCalledWith('ROLLBACK');
  expect(mocks.transaction.mock.calls.some(([sql])=>sql.includes('INSERT INTO public.organizations'))).toBe(false);
  expect(mocks.release).toHaveBeenCalled();
});
it('creates a workspace and membership atomically using the verified subject',async()=>{
  mocks.transaction.mockImplementation(async(sql:string)=>sql.startsWith('SELECT id FROM public.memberships')?{rowCount:0,rows:[]}:sql.startsWith('INSERT INTO public.organizations')?{rows:[{id:'workspace-id'}]}:{rows:[]});
  const result=await request(supabaseApp).post('/api/v1/auth/workspace').set('X-Requested-With','PeopleSync').set('Authorization','Bearer test').send({company:'Test',code:'test',terms:true,userId:'attacker'});
  expect(result.status).toBe(201);
  expect(mocks.transaction).toHaveBeenCalledWith("INSERT INTO public.memberships(organization_id,user_id,role) VALUES ($1,$2,'owner')",['workspace-id',subject]);
  expect(mocks.transaction).toHaveBeenCalledWith('COMMIT');
});
it('rejects invitations issued to another email without linking a membership',async()=>{
 mocks.transaction.mockImplementation(async(sql:string)=>sql.includes('SELECT i.*')?{rows:[{id:'invite',email:'someone-else@example.invalid',status:'Active'}]}:{rows:[],rowCount:0});
 const r=await request(supabaseApp).post('/api/v1/auth/accept-invitation').set('X-Requested-With','PeopleSync').set('Authorization','Bearer test').send({token:'a'.repeat(64)});
 expect(r.status).toBe(403);expect(mocks.transaction).toHaveBeenCalledWith('ROLLBACK');expect(mocks.transaction.mock.calls.some(([s])=>s.startsWith('INSERT INTO memberships'))).toBe(false);
});
it('accepts an invitation only for the verified identity and fixed employee role',async()=>{
 mocks.transaction.mockImplementation(async(sql:string)=>sql.includes('SELECT i.*')?{rows:[{id:'invite',email:'test@example.invalid',status:'Active',organization_id:'workspace',employee_id:'employee'}]}:{rows:[],rowCount:0});
 const r=await request(supabaseApp).post('/api/v1/auth/accept-invitation').set('X-Requested-With','PeopleSync').set('Authorization','Bearer test').send({token:'b'.repeat(64),role:'owner',userId:'attacker'});
 expect(r.status).toBe(200);expect(mocks.transaction).toHaveBeenCalledWith("INSERT INTO memberships(organization_id,user_id,role) VALUES ($1,$2,'employee') ON CONFLICT(organization_id,user_id) DO NOTHING",['workspace',subject]);expect(mocks.transaction).toHaveBeenCalledWith('COMMIT');
});
it('rejects an expired or already accepted invitation',async()=>{
 mocks.transaction.mockResolvedValue({rows:[],rowCount:0});
 const r=await request(supabaseApp).post('/api/v1/auth/accept-invitation').set('X-Requested-With','PeopleSync').set('Authorization','Bearer test').send({token:'c'.repeat(64)});
 expect(r.status).toBe(403);expect(mocks.transaction).toHaveBeenCalledWith('ROLLBACK');
});
