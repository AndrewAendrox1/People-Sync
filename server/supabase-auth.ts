import {createRemoteJWKSet,jwtVerify} from 'jose';
import type {Request,Response,NextFunction} from 'express';
import {databasePool} from './database';

export class AppError extends Error{
  constructor(public status:number,message:string){super(message);}
}
export const handle=(fn:(req:any,res:Response)=>Promise<unknown>)=>
  (req:Request,res:Response,next:NextFunction)=>Promise.resolve(fn(req,res)).catch(next);

let jwks:ReturnType<typeof createRemoteJWKSet>|undefined;
const identityCache=new Map<string,{user:{id:string;name:string;email:string;emailVerified:boolean};expires:number}>();
const identityPending=new Map<string,Promise<{id:string;name:string;email:string;emailVerified:boolean}>>();
export async function verifyIdentity(header?:string){
  if(!header?.startsWith('Bearer '))throw new AppError(401,'Please sign in');
  const base=process.env.SUPABASE_URL?.replace(/\/$/,'');
  if(!base)throw new AppError(503,'Sign-in configuration is incomplete');
  let subject:string;
  try{
    jwks??=createRemoteJWKSet(new URL(`${base}/auth/v1/.well-known/jwks.json`),{cacheMaxAge:10*60_000});
    const {payload}=await jwtVerify(header.slice(7),jwks,{issuer:`${base}/auth/v1`,audience:'authenticated',algorithms:['ES256','RS256']});
    if(!payload.sub)throw new Error('Missing subject');
    subject=payload.sub;
  }catch{throw new AppError(401,'Your session has expired. Please sign in again.');}
  const cached=identityCache.get(subject);
  if(cached&&cached.expires>Date.now())return cached.user;
  const pending=identityPending.get(subject);
  if(pending)return pending;
  const lookup=(async()=>{
    const result=await databasePool().query(
      `SELECT id::text,COALESCE(NULLIF(raw_user_meta_data->>'name',''),NULLIF(raw_user_meta_data->>'full_name',''),split_part(email,'@',1)) name,email,(email_confirmed_at IS NOT NULL) "emailVerified"
       FROM auth.users WHERE id=$1 AND deleted_at IS NULL AND (banned_until IS NULL OR banned_until<now())`,[subject]);
    const user=result.rows[0];
    if(!user)throw new AppError(401,'Account unavailable');
    if(!user.emailVerified)throw new AppError(403,'Verify your email before opening your workspace');
    const identity=user as {id:string;name:string;email:string;emailVerified:boolean};
    if(identityCache.size>500)for(const [key,entry] of identityCache)if(entry.expires<=Date.now())identityCache.delete(key);
    identityCache.set(subject,{user:identity,expires:Date.now()+30_000});
    return identity;
  })().finally(()=>identityPending.delete(subject));
  identityPending.set(subject,lookup);
  return lookup;
}

export async function loadWorkspace(user:{id:string;name:string;email:string}){
  const result=await databasePool().query(`SELECT m.id AS membership_id,m.role,o.*,
    e.id AS employee_id FROM public.memberships m
    JOIN public.organizations o ON o.id=m.organization_id
    LEFT JOIN public.employees e ON e.organization_id=o.id AND e.user_id=m.user_id
    WHERE m.user_id=$1 AND m.active ORDER BY m.created_at LIMIT 1`,[user.id]);
  const row=result.rows[0];
  if(!row)return {user:{...user,role:null},organization:null,needsWorkspace:true};
  return {user:{...user,_id:user.id,role:row.role,organization:row.id,employee:row.employee_id},organization:{...row,_id:row.id},needsWorkspace:false};
}
