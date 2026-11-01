import {createHash} from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import {rateLimit} from 'express-rate-limit';
import {z} from 'zod';
import path from 'node:path';
import {config} from './config';
import {databasePool} from './database';
import {workspaceRoutes} from './workspace';
import {handle,AppError,verifyIdentity,loadWorkspace} from './supabase-auth';

export const workspaceInput = z.object({
  company:z.string().trim().min(2).max(150),
  code:z.string().trim().min(3).max(20).regex(/^[a-zA-Z0-9-]+$/,'Use letters, numbers and hyphens only').transform(s=>s.toUpperCase()),
  terms:z.literal(true),
});
export const supabaseApp=express();
supabaseApp.disable('x-powered-by');
supabaseApp.disable('etag');
supabaseApp.use(helmet(),express.json({limit:'100kb'}));
supabaseApp.use('/api',rateLimit({windowMs:60_000,limit:120}));
supabaseApp.use('/api',(req,res,next)=>{
  res.set('Cache-Control','no-store');
  if(config.production)return next();
  const start=Date.now();
  res.on('finish',()=>console.log(`[api] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now()-start}ms${req.headers['x-client-token-ms']?` token=${req.headers['x-client-token-ms']}ms`:''}`));
  next();
});
supabaseApp.use('/api',(req,res,next)=>{
  if (!['GET','HEAD','OPTIONS'].includes(req.method) && req.headers['x-requested-with']!=='PeopleSync') {res.status(403).json({error:'Missing request protection header'});return;}
  if(req.headers.origin && req.headers.origin!==new URL(config.url).origin){res.status(403).json({error:'Origin not allowed'});return;}
  next();
});
supabaseApp.get('/api/health',handle(async(_req,res)=>{await databasePool().query('SELECT 1');res.json({status:'ok',database:'supabase'});}));
supabaseApp.use('/api/v1',async(req:any,_res,next)=>{
  try{req.identity=await verifyIdentity(req.headers.authorization);next();}catch(error){next(error);}
});
supabaseApp.get('/api/v1/auth/me',handle(async(req,res)=>res.json(await loadWorkspace(req.identity))));
supabaseApp.post('/api/v1/auth/workspace',handle(async(req,res)=>{
  const data=workspaceInput.parse(req.body);
  const client=await databasePool().connect();
  try{
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[req.identity.id]);
    const existing=await client.query('SELECT id FROM public.memberships WHERE user_id=$1',[req.identity.id]);
    if(existing.rowCount)throw new AppError(409,'This account already belongs to a workspace. Sign in to open it.');
    const org=await client.query('INSERT INTO public.organizations(name,code) VALUES ($1,$2) RETURNING id',[data.company,data.code]);
    const id=org.rows[0].id;
    await client.query("INSERT INTO public.memberships(organization_id,user_id,role) VALUES ($1,$2,'owner')",[id,req.identity.id]);
    await client.query("INSERT INTO public.shifts(organization_id,name,code,start_time,end_time) VALUES ($1,'Morning Shift','MORNING','09:00','18:00')",[id]);
    await client.query("INSERT INTO public.leave_policies(organization_id,name,code,entitlement) VALUES ($1,'Casual Leave','CL',4),($1,'Sick Leave','SL',7)",[id]);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  res.status(201).json(await loadWorkspace(req.identity));
}));
supabaseApp.post('/api/v1/auth/accept-invitation',handle(async(req,res)=>{
 const {token}=z.object({token:z.string().regex(/^[a-f0-9]{64}$/)}).parse(req.body);
 const db=await databasePool().connect();
 try{await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[req.identity.id]);
 const invitation=(await db.query(`SELECT i.*,e.email,e.status,e.user_id FROM private.workspace_invitations i JOIN employees e ON e.organization_id=i.organization_id AND e.id=i.employee_id WHERE i.token_hash=$1 AND i.expires_at>now() AND i.accepted_at IS NULL FOR UPDATE OF i,e`,[createHash('sha256').update(token).digest('hex')])).rows[0];
 if(!invitation||invitation.email.toLowerCase()!==req.identity.email.toLowerCase()||invitation.status!=='Active')throw new AppError(403,'This invitation is expired or belongs to a different email address');
 if(invitation.user_id)throw new AppError(409,'This employee is already linked to an account');
 if((await db.query('SELECT 1 FROM memberships WHERE user_id=$1 AND organization_id<>$2',[req.identity.id,invitation.organization_id])).rowCount)throw new AppError(409,'This account already belongs to another workspace');
 await db.query("INSERT INTO memberships(organization_id,user_id,role) VALUES ($1,$2,'employee') ON CONFLICT(organization_id,user_id) DO NOTHING",[invitation.organization_id,req.identity.id]);
 await db.query('UPDATE employees SET user_id=$3 WHERE organization_id=$1 AND id=$2',[invitation.organization_id,invitation.employee_id,req.identity.id]);
 await db.query('UPDATE private.workspace_invitations SET accepted_at=now() WHERE id=$1',[invitation.id]);
 await db.query('COMMIT');
 }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 res.json(await loadWorkspace(req.identity));
}));
supabaseApp.use('/api/v1',workspaceRoutes);
supabaseApp.use('/api',(_req,res)=>res.status(404).json({error:'This endpoint was not found.'}));
if(config.production){supabaseApp.use(express.static(path.resolve('dist')));supabaseApp.get('/{*path}',(_req,res)=>res.sendFile(path.resolve('dist/index.html')));}
supabaseApp.use((error:any,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
  if(error.name==='ZodError'){res.status(400).json({error:'Review the highlighted fields',details:error.issues});return;}
  if(error.code==='23505'){res.status(409).json({error:'A record with that code, email, or date already exists in this workspace.'});return;}
  if(['23503','23514','22P02'].includes(error.code)){res.status(400).json({error:'Check the selected records and values. Leave allocation must cover used and pending leave.'});return;}
  if(!error.status)console.error('Workspace request failed',error.code||error.name);
  res.status(error.status||503).json({error:error.status?error.message:'People Sync could not reach its database. Please try again.'});
});
