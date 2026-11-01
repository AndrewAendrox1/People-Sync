import {Router} from 'express';
import {z} from 'zod';
import {DateTime} from 'luxon';
import type {PoolClient} from 'pg';
import {databasePool} from './database';
import {handle,AppError} from './supabase-auth';
import {shiftSchema,time} from './validation';
import {calculate,workDate,windowFor} from './services/attendance';
import {sendMail} from './services/email';

const uuid=z.string().uuid();
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>DateTime.fromISO(v).isValid,'Invalid date');
const optionalId=z.preprocess(v=>v===''?undefined:v,uuid.optional());
const optionalDate=z.preprocess(v=>v===''?undefined:v,date.optional());
const permissions:Record<string,string[]>={owner:['*'],admin:['*'],hr:['employees','onboarding','leaves','approvals','reports','documents'],attendance:['attendance','shifts','reports'],approver:['approvals'],project:['projects'],employee:[]};
type Context={db:PoolClient;org:any;member:any;identity:any};
const can=(c:Context,p:string)=>permissions[c.member.role]?.some(x=>x==='*'||x===p);
const permit=(c:Context,p:string)=>{if(!can(c,p))throw new AppError(403,'You do not have permission for this action');};
const rows=async(c:Context,sql:string,values:any[]=[]) => (await c.db.query(sql,values)).rows;
const one=async(c:Context,sql:string,values:any[]=[]) => (await rows(c,sql,values))[0];
const found=(r:any,label='Record')=>{if(!r)throw new AppError(404,`${label} not found`);return r;};
const own=(c:Context,p:string)=>can(c,p)?null:c.member.employee_id||'00000000-0000-4000-8000-000000000000';
const dayString=(v:any)=>v instanceof Date?DateTime.fromJSDate(v).toISODate()!:String(v).slice(0,10);
const base=(r:any)=>({...r,_id:r.id,createdAt:r.created_at});
const shift=(r:any)=>({...base(r),start:r.start_time.slice(0,5),end:r.end_time.slice(0,5),secondHalf:'13:30',breakMinutes:60,graceMinutes:15,halfMinutes:210,fullMinutes:420,workdays:[1,2,3,4,5],version:1,...r.policy});
const employee=(r:any)=>({...r.profile,...base(r),employeeId:r.employee_code,user:r.user_id,joiningDate:r.joining_date?dayString(r.joining_date):'',shift:r.shift_id||'',manager:r.manager_id||''});
const attendance=(r:any)=>({...base(r),...r.result,date:dayString(r.work_date),checkIn:r.check_in,checkOut:r.check_out,employee:r.employee});
const request=(r:any)=>({...base(r),...r.details,from:dayString(r.from_date),to:dayString(r.to_date),employee:r.employee,user:r.user_id});
async function audit(c:Context,action:string,type:string,id:string,changes:any={}){await c.db.query('INSERT INTO audit_events(organization_id,actor_membership_id,action,entity_type,entity_id,changes) VALUES ($1,$2,$3,$4,$5,$6)',[c.org.id,c.member.id,action,type,id,JSON.stringify(changes)]);}
async function reference(c:Context,table:'employees'|'shifts'|'leave_policies'|'projects',id:string){return found(await one(c,`SELECT * FROM ${table} WHERE organization_id=$1 AND id=$2`,[c.org.id,uuid.parse(id)]));}
// Every route runs in a transaction with a verified active membership. All SQL
// scopes records and joins to that membership's organization, never a client org ID.
export const workspaceRoutes=Router();
// Reads skip BEGIN/COMMIT and reuse the membership/org lookup for 30 s, cutting
// each GET from four database round-trips to one. Writes always use a fresh
// transaction and clear the cache.
const contextCache=new Map<string,{member:any;org:any;expires:number}>();
function route(method:'get'|'post'|'patch'|'delete',path:string,fn:(c:Context,req:any)=>Promise<any>){
 workspaceRoutes[method](path,handle(async(req,res)=>{
  const db=await databasePool().connect();
  const read=req.method==='GET';
  let inTx=false;
  try{
   let context=read?contextCache.get(req.identity.id):undefined;
   if(!context||context.expires<=Date.now()){
    if(!read){await db.query('BEGIN');inTx=true;}
    const m=(await db.query(`SELECT m.*,e.id employee_id,to_jsonb(o) org FROM memberships m JOIN organizations o ON o.id=m.organization_id LEFT JOIN employees e ON e.organization_id=m.organization_id AND e.user_id=m.user_id WHERE m.user_id=$1 AND m.active ORDER BY m.created_at LIMIT 1${read?'':' FOR SHARE OF m'}`,[req.identity.id])).rows[0];
    if(!m)throw new AppError(409,'Create or join a workspace first');
    context={member:m,org:m.org,expires:Date.now()+30_000};
    if(contextCache.size>500)for(const [key,entry] of contextCache)if(entry.expires<=Date.now())contextCache.delete(key);
    contextCache.set(req.identity.id,context);
   }
   const c={db,member:context.member,org:context.org as any,identity:req.identity};
   if(req.params.id)uuid.parse(req.params.id);
   const result=await fn(c,req);
   if(inTx){await db.query('COMMIT');inTx=false;}
   if(!read)contextCache.delete(req.identity.id);
   res.json(result??{message:'Saved'});
  }catch(e){if(inTx)await db.query('ROLLBACK').catch(()=>{});throw e;}finally{db.release();}
 }));
}
route('get','/shifts',async c=>({items:(await rows(c,'SELECT * FROM shifts WHERE organization_id=$1 ORDER BY name',[c.org.id])).map(shift)}));
for(const method of ['post','patch'] as const)route(method,method==='post'?'/shifts':'/shifts/:id',async(c,req)=>{
 permit(c,'shifts');const d=shiftSchema.parse(req.body);const policy={...d};
 let r;if(method==='post')r=await one(c,'INSERT INTO shifts(organization_id,name,code,start_time,end_time,policy,active) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',[c.org.id,d.name,d.code,d.start,d.end,JSON.stringify({...policy,version:1}),d.active]);
 else r=found(await one(c,"UPDATE shifts SET name=$3,code=$4,start_time=$5,end_time=$6,policy=$7::jsonb || jsonb_build_object('version',COALESCE((policy->>'version')::int,1)+1),active=$8 WHERE organization_id=$1 AND id=$2 RETURNING *",[c.org.id,req.params.id,d.name,d.code,d.start,d.end,JSON.stringify(policy),d.active]),'Shift');
 await audit(c,method==='post'?'create':'update','Shift',r.id);return shift(r);
});
route('delete','/shifts/:id',async(c,req)=>{permit(c,'shifts');const r=found(await one(c,'UPDATE shifts SET active=false WHERE organization_id=$1 AND id=$2 RETURNING *',[c.org.id,req.params.id]),'Shift');await audit(c,'deactivate','Shift',r.id);return shift(r);});
const employeeInput=z.object({name:z.string().trim().min(2).max(100),email:z.string().trim().toLowerCase().email(),department:z.string().trim().min(1).max(80),designation:z.string().max(100).optional(),joiningDate:date,status:z.enum(['Active','Inactive','Exited']).default('Active'),shift:optionalId,manager:optionalId,phone:z.string().max(30).optional(),employmentType:z.enum(['Full time','Part time','Contract']).default('Full time'),location:z.string().max(100).optional()});
route('get','/employees',async(c,req)=>{permit(c,'employees');const page=z.coerce.number().int().min(1).max(100000).parse(req.query.page||1);const args=[c.org.id,'%'+String(req.query.q||'')+'%',String(req.query.status||'')];const filter="organization_id=$1 AND (name ILIKE $2 OR email ILIKE $2 OR employee_code ILIKE $2) AND ($3='' OR status=$3)";const list=await rows(c,`SELECT *,count(*) OVER() total FROM employees WHERE ${filter} ORDER BY name,id LIMIT 20 OFFSET $4`,[...args,(page-1)*20]);return {items:list.map(employee),total:Number(list[0]?.total||0),page};});
route('get','/employees/me',async c=>{const r=await one(c,'SELECT * FROM employees WHERE organization_id=$1 AND id=$2',[c.org.id,c.member.employee_id]);return r?employee(r):null;});
route('patch','/employees/me',async(c,req)=>{const d=z.object({phone:z.string().max(30).optional(),emergencyContact:z.string().max(200).optional(),address:z.string().max(500).optional(),education:z.string().max(1000).optional(),experience:z.string().max(2000).optional()}).strict().parse(req.body);const r=found(await one(c,'UPDATE employees SET profile=profile || $3::jsonb WHERE organization_id=$1 AND id=$2 RETURNING *',[c.org.id,c.member.employee_id,JSON.stringify(d)]),'Employee profile');await audit(c,'update-own-profile','Employee',r.id);return employee(r);});
for(const method of ['post','patch'] as const)route(method,method==='post'?'/employees':'/employees/:id',async(c,req)=>{
 permit(c,'employees');const d=employeeInput.parse(req.body);if(d.shift)await reference(c,'shifts',d.shift);if(d.manager)await reference(c,'employees',d.manager);
 const profile={phone:d.phone,employmentType:d.employmentType,location:d.location};let r;
 if(method==='post'){
  await c.db.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[c.org.id]);
  const sequence=Number((await one(c,"SELECT COALESCE(max(substring(employee_code from '^EMP([0-9]+)$')::int),0)+1 n FROM employees WHERE organization_id=$1",[c.org.id])).n);
  r=await one(c,'INSERT INTO employees(organization_id,employee_code,name,email,department,designation,joining_date,status,shift_id,manager_id,profile) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',[c.org.id,`EMP${String(sequence).padStart(4,'0')}`,d.name,d.email,d.department,d.designation,d.joiningDate,d.status,d.shift||null,d.manager||null,JSON.stringify(profile)]);
  await c.db.query('INSERT INTO leave_balances(organization_id,employee_id,policy_id,year,allocated) SELECT organization_id,$2,id,$3,entitlement FROM leave_policies WHERE organization_id=$1 AND active',[c.org.id,r.id,DateTime.now().setZone(c.org.timezone).year]);
  for(const title of ['Complete personal information','Upload required documents','Review company handbook'])await c.db.query('INSERT INTO onboarding_tasks(organization_id,employee_id,title) VALUES ($1,$2,$3)',[c.org.id,r.id,title]);
 }else{
  const before=await reference(c,'employees',req.params.id);
  if(before.user_id && before.email.toLowerCase()!==d.email)throw new AppError(409,'A linked account email cannot be changed from the employee directory');
  r=found(await one(c,'UPDATE employees SET name=$3,email=$4,department=$5,designation=$6,joining_date=$7,status=$8,shift_id=$9,manager_id=$10,profile=profile || $11::jsonb WHERE organization_id=$1 AND id=$2 RETURNING *',[c.org.id,req.params.id,d.name,d.email,d.department,d.designation,d.joiningDate,d.status,d.shift||null,d.manager||null,JSON.stringify(profile)]));
  if(r.user_id && d.status!=='Active')await c.db.query("UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2 AND role<>'owner'",[c.org.id,r.user_id]);
 }
 await audit(c,method==='post'?'create':'update','Employee',r.id);return employee(r);
});
route('get','/leaves/policies',async c=>({items:(await rows(c,'SELECT * FROM leave_policies WHERE organization_id=$1 ORDER BY name',[c.org.id])).map(r=>({...base(r),entitlement:Number(r.entitlement),accrual:'Annual',carryForward:0,...r.policy}))}));
route('post','/leaves/policies',async(c,req)=>{permit(c,'leaves');const d=z.object({name:z.string().trim().min(2).max(100),code:z.string().trim().min(1).max(10),entitlement:z.number().min(0).max(366),carryForward:z.number().min(0).max(366).default(0)}).parse(req.body);const r=await one(c,'INSERT INTO leave_policies(organization_id,name,code,entitlement,policy) VALUES ($1,$2,$3,$4,$5) RETURNING *',[c.org.id,d.name,d.code.toUpperCase(),d.entitlement,JSON.stringify({carryForward:d.carryForward,accrual:'Annual'})]);await audit(c,'create','LeavePolicy',r.id);return base(r);});
route('get','/leaves/balances',async c=>({items:(await rows(c,`SELECT b.*,jsonb_build_object('name',e.name,'_id',e.id) employee,jsonb_build_object('name',p.name,'_id',p.id) policy FROM leave_balances b JOIN employees e ON e.organization_id=b.organization_id AND e.id=b.employee_id JOIN leave_policies p ON p.organization_id=b.organization_id AND p.id=b.policy_id WHERE b.organization_id=$1 AND ($2::uuid IS NULL OR b.employee_id=$2) ORDER BY e.name,b.year DESC`,[c.org.id,own(c,'leaves')])).map(r=>({...base(r),allocated:Number(r.allocated),used:Number(r.used),reserved:Number(r.reserved)}))}));
route('post','/leaves/allocate',async(c,req)=>{permit(c,'leaves');const d=z.object({employee:uuid,policy:uuid,year:z.number().int().min(2020).max(2100),allocated:z.number().min(0).max(366),reason:z.string().min(5).max(2000)}).parse(req.body);await reference(c,'employees',d.employee);await reference(c,'leave_policies',d.policy);const r=await one(c,'INSERT INTO leave_balances(organization_id,employee_id,policy_id,year,allocated) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(organization_id,employee_id,policy_id,year) DO UPDATE SET allocated=excluded.allocated WHERE leave_balances.used+leave_balances.reserved<=excluded.allocated RETURNING *',[c.org.id,d.employee,d.policy,d.year,d.allocated]);if(!r)throw new AppError(409,'Allocation cannot be below used and pending leave');await audit(c,'allocate','Balance',r.id,{allocated:d.allocated,reason:d.reason});return base(r);});
route('get','/projects',async c=>({items:(await rows(c,`SELECT p.*,COALESCE((SELECT jsonb_agg(pm.employee_id) FROM project_members pm WHERE pm.organization_id=p.organization_id AND pm.project_id=p.id),'[]') members FROM projects p WHERE p.organization_id=$1 AND NOT p.archived AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM project_members pm WHERE pm.organization_id=p.organization_id AND pm.project_id=p.id AND pm.employee_id=$2)) ORDER BY p.created_at DESC`,[c.org.id,own(c,'projects')])).map(r=>({...base(r),deadline:r.deadline?dayString(r.deadline):''}))}));
route('post','/projects',async(c,req)=>{permit(c,'projects');const d=z.object({name:z.string().trim().min(2).max(150),description:z.string().max(3000).default(''),deadline:date,status:z.enum(['Planning','Active','On Hold','Completed']).default('Planning'),members:z.array(uuid).max(500).default([])}).parse(req.body);for(const id of d.members)await reference(c,'employees',id);const r=await one(c,'INSERT INTO projects(organization_id,name,description,deadline,status) VALUES ($1,$2,$3,$4,$5) RETURNING *',[c.org.id,d.name,d.description,d.deadline,d.status]);for(const id of new Set(d.members))await c.db.query('INSERT INTO project_members VALUES ($1,$2,$3)',[c.org.id,r.id,id]);await audit(c,'create','Project',r.id);return {...base(r),members:d.members};});
async function projectAccess(c:Context,id:string){const r=await reference(c,'projects',id);if(!can(c,'projects')&&!await one(c,'SELECT 1 FROM project_members WHERE organization_id=$1 AND project_id=$2 AND employee_id=$3',[c.org.id,id,c.member.employee_id]))throw new AppError(404,'Project not found');return r;}
route('get','/projects/:id/tasks',async(c,req)=>{await projectAccess(c,req.params.id);return {items:(await rows(c,'SELECT * FROM tasks WHERE organization_id=$1 AND project_id=$2 ORDER BY created_at',[c.org.id,req.params.id])).map(base)};});
route('post','/projects/:id/tasks',async(c,req)=>{permit(c,'projects');await projectAccess(c,req.params.id);const d=z.object({title:z.string().trim().min(2).max(300),deadline:optionalDate,employee:optionalId}).parse(req.body);if(d.employee&&!await one(c,'SELECT 1 FROM project_members WHERE organization_id=$1 AND project_id=$2 AND employee_id=$3',[c.org.id,req.params.id,d.employee]))throw new AppError(400,'Assignee must be a project member');const r=await one(c,'INSERT INTO tasks(organization_id,project_id,title,deadline,employee_id) VALUES ($1,$2,$3,$4,$5) RETURNING *',[c.org.id,req.params.id,d.title,d.deadline||null,d.employee||null]);await audit(c,'create','Task',r.id);return base(r);});
route('patch','/tasks/:id',async(c,req)=>{const d=z.object({status:z.enum(['To do','In progress','Done'])}).parse(req.body);const r=found(await one(c,'UPDATE tasks SET status=$3 WHERE organization_id=$1 AND id=$2 AND ($4::uuid IS NULL OR employee_id=$4) RETURNING *',[c.org.id,req.params.id,d.status,own(c,'projects')]),'Task');await audit(c,'update','Task',r.id);return base(r);});
route('get','/people-start',async c=>({items:(await rows(c,`SELECT t.*,jsonb_build_object('name',e.name,'_id',e.id) employee FROM onboarding_tasks t JOIN employees e ON e.organization_id=t.organization_id AND e.id=t.employee_id WHERE t.organization_id=$1 AND ($2::uuid IS NULL OR t.employee_id=$2) ORDER BY t.created_at DESC`,[c.org.id,own(c,'onboarding')])).map(r=>({...base(r),deadline:r.deadline?dayString(r.deadline):''}))}));
route('patch','/people-start/:id',async(c,req)=>{const d=z.object({status:z.enum(['Not Started','In Progress','Pending Review','Completed','Rejected'])}).parse(req.body);if(['Completed','Rejected'].includes(d.status))permit(c,'onboarding');const r=found(await one(c,'UPDATE onboarding_tasks SET status=$3 WHERE organization_id=$1 AND id=$2 AND ($4::uuid IS NULL OR employee_id=$4) RETURNING *',[c.org.id,req.params.id,d.status,own(c,'onboarding')]));await audit(c,'update','Onboarding',r.id);return base(r);});
route('get','/settings',async c=>{permit(c,'*');return {...c.org.settings,...base(c.org)};});
route('patch','/settings',async(c,req)=>{permit(c,'*');const d=z.object({name:z.string().trim().min(2).max(150),email:z.string().email(),phone:z.string().max(30).optional(),domain:z.string().max(253).optional(),website:z.string().url().or(z.literal('')).optional(),address:z.string().max(1000).optional(),timezone:z.string().refine(v=>DateTime.now().setZone(v).isValid),workdays:z.array(z.number().int().min(1).max(7)).min(1),setupComplete:z.boolean().optional()}).parse(req.body);const {name,timezone,workdays,...settings}=d;await c.db.query('UPDATE organizations SET name=$2,timezone=$3,workdays=$4,settings=settings || $5::jsonb WHERE id=$1',[c.org.id,name,timezone,workdays,JSON.stringify(settings)]);await audit(c,'update','Organization',c.org.id);return {message:'Settings saved'};});
route('get','/holidays',async c=>({items:(await rows(c,'SELECT * FROM holidays WHERE organization_id=$1 ORDER BY holiday_date',[c.org.id])).map(r=>({...base(r),date:dayString(r.holiday_date)}))}));
route('post','/holidays',async(c,req)=>{permit(c,'shifts');const d=z.object({name:z.string().trim().min(2).max(150),date}).parse(req.body);const r=await one(c,'INSERT INTO holidays(organization_id,name,holiday_date) VALUES ($1,$2,$3) RETURNING *',[c.org.id,d.name,d.date]);await audit(c,'create','Holiday',r.id);return base(r);});
route('get','/users',async c=>{permit(c,'*');return {items:(await rows(c,"SELECT m.id,m.role,m.active,COALESCE(NULLIF(u.raw_user_meta_data->>'name',''),NULLIF(u.raw_user_meta_data->>'full_name',''),split_part(u.email,'@',1)) name,u.email,(u.email_confirmed_at IS NOT NULL) verified FROM memberships m JOIN auth.users u ON u.id=m.user_id WHERE m.organization_id=$1 ORDER BY m.created_at",[c.org.id])).map(base)};});
route('patch','/users/:id',async(c,req)=>{permit(c,'*');const d=z.object({role:z.enum(['admin','hr','attendance','approver','project','employee'])}).parse(req.body);if(req.params.id===c.member.id)throw new AppError(403,'You cannot change your own role');const r=found(await one(c,"UPDATE memberships SET role=$3 WHERE organization_id=$1 AND id=$2 AND role<>'owner' RETURNING *",[c.org.id,req.params.id,d.role]));await audit(c,'role-change','Membership',r.id,d);return {message:'Role updated'};});
route('get','/audit-logs',async c=>{permit(c,'*');return {items:(await rows(c,`SELECT a.*,jsonb_build_object('name',COALESCE(NULLIF(u.raw_user_meta_data->>'name',''),NULLIF(u.raw_user_meta_data->>'full_name',''),split_part(u.email,'@',1))) actor FROM audit_events a LEFT JOIN memberships m ON m.organization_id=a.organization_id AND m.id=a.actor_membership_id LEFT JOIN auth.users u ON u.id=m.user_id WHERE a.organization_id=$1 ORDER BY a.created_at DESC LIMIT 100`,[c.org.id])).map(r=>({...base(r),entity:r.entity_type,entityId:r.entity_id}))};});
route('get','/notifications',async c=>({items:(await rows(c,'SELECT * FROM notifications WHERE organization_id=$1 AND recipient_membership_id=$2 ORDER BY created_at DESC LIMIT 100',[c.org.id,c.member.id])).map(r=>({...base(r),read:!!r.read_at}))}));
route('patch','/notifications/:id',async(c,req)=>{found(await one(c,'UPDATE notifications SET read_at=now() WHERE organization_id=$1 AND recipient_membership_id=$2 AND id=$3 RETURNING id',[c.org.id,c.member.id,req.params.id]));return {message:'Marked as read'};});
route('get','/attendance/today',async c=>{
 const e=await one(c,'SELECT * FROM employees WHERE organization_id=$1 AND id=$2 AND status=\'Active\'',[c.org.id,c.member.employee_id]);
 const s=e?.shift_id?await one(c,'SELECT * FROM shifts WHERE organization_id=$1 AND id=$2 AND active',[c.org.id,e.shift_id]):null;
 if(!s)return {record:null,shift:null,timezone:c.org.timezone,message:'An active employee profile and assigned shift are required to clock in.'};
 const policy=shift(s),day=workDate(new Date(),policy,c.org.timezone);
 const r=await one(c,'SELECT * FROM attendance WHERE organization_id=$1 AND employee_id=$2 AND work_date=$3',[c.org.id,e.id,day]);
 return {record:r?attendance(r):null,shift:policy,date:day,timezone:c.org.timezone};
});
for(const endpoint of ['/attendance','/reports'])route('get',endpoint,async(c,req)=>{
 if(endpoint==='/reports')permit(c,'reports');
 const from=req.query.date||req.query.from,to=req.query.date||req.query.to;
 return {items:(await rows(c,`SELECT a.*,jsonb_build_object('name',e.name,'department',e.department,'_id',e.id) employee FROM attendance a JOIN employees e ON e.organization_id=a.organization_id AND e.id=a.employee_id WHERE a.organization_id=$1 AND ($2::uuid IS NULL OR a.employee_id=$2) AND ($3::date IS NULL OR a.work_date>=$3) AND ($4::date IS NULL OR a.work_date<=$4) ORDER BY a.work_date DESC LIMIT 1000`,[c.org.id,own(c,'attendance'),from?date.parse(from):null,to?date.parse(to):null])).map(attendance)};
});
route('post','/attendance/punch',async(c,req)=>{
 const {type}=z.object({type:z.enum(['in','out'])}).parse(req.body),now=new Date();
 const e=await one(c,"SELECT * FROM employees WHERE organization_id=$1 AND id=$2 AND status='Active' FOR UPDATE",[c.org.id,c.member.employee_id]);
 if(!e)throw new AppError(403,'An active employee profile is required');
 const s=await one(c,'SELECT * FROM shifts WHERE organization_id=$1 AND id=$2 AND active',[c.org.id,e.shift_id]);
 if(!s)throw new AppError(400,'No active shift is assigned');
 const policy=shift(s),day=workDate(now,policy,c.org.timezone);
 let r=await one(c,'SELECT * FROM attendance WHERE organization_id=$1 AND employee_id=$2 AND work_date=$3 FOR UPDATE',[c.org.id,e.id,day]);
 if(type==='in'){
  if(r?.check_in)return attendance(r);
  const w=windowFor(day,policy,c.org.timezone);
  if(now>w.end.toJSDate())throw new AppError(400,'This shift has ended. Submit a TimeReconcile request.');
  if(!policy.workdays.includes(w.start.weekday)||await one(c,'SELECT 1 FROM holidays WHERE organization_id=$1 AND holiday_date=$2',[c.org.id,day]))throw new AppError(400,'This is not a scheduled working day');
  if(await one(c,"SELECT 1 FROM requests WHERE organization_id=$1 AND employee_id=$2 AND kind='Leave' AND status='Approved' AND from_date<=$3 AND to_date>=$3",[c.org.id,e.id,day]))throw new AppError(409,'You have approved leave today');
  r=await one(c,'INSERT INTO attendance(organization_id,employee_id,work_date,check_in,shift_snapshot,result) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',[c.org.id,e.id,day,now,JSON.stringify(policy),JSON.stringify(calculate(day,policy,c.org.timezone,now,undefined,now))]);
 }else{
  if(!r?.check_in)r=await one(c,'SELECT * FROM attendance WHERE organization_id=$1 AND employee_id=$2 AND check_in IS NOT NULL AND check_out IS NULL ORDER BY work_date DESC LIMIT 1 FOR UPDATE',[c.org.id,e.id]);
  if(!r?.check_in)throw new AppError(409,'Clock in before clocking out');
  if(r.check_out)return attendance(r);
  if(now.getTime()-new Date(r.check_in).getTime()>86400000)throw new AppError(400,'Submit a TimeReconcile request for this missing punch');
  const result=calculate(dayString(r.work_date),r.shift_snapshot,c.org.timezone,new Date(r.check_in),now);
  r=await one(c,'UPDATE attendance SET check_out=$3,result=$4 WHERE organization_id=$1 AND id=$2 RETURNING *',[c.org.id,r.id,now,JSON.stringify(result)]);
 }
 await c.db.query('INSERT INTO punches(organization_id,attendance_id,kind,punched_at) VALUES ($1,$2,$3,$4)',[c.org.id,r.id,type,now]);
 await audit(c,`clock-${type}`,'Attendance',r.id);return attendance(r);
});
route('get','/requests',async(c,req)=>({items:(await rows(c,`SELECT r.*,e.user_id,jsonb_build_object('name',e.name,'department',e.department,'_id',e.id) employee FROM requests r JOIN employees e ON e.organization_id=r.organization_id AND e.id=r.employee_id WHERE r.organization_id=$1 AND ($2::uuid IS NULL OR r.employee_id=$2) AND ($3='' OR r.kind=$3) AND ($4='' OR r.status=$4) ORDER BY r.created_at DESC LIMIT 100`,[c.org.id,req.query.mine==='true'?c.member.employee_id||'00000000-0000-4000-8000-000000000000':own(c,'approvals'),String(req.query.kind||''),String(req.query.status||'')])).map(request)}));
route('post','/requests',async(c,req)=>{
 const d=z.object({kind:z.enum(['Leave','TimeReconcile','Duty Pass','Hour Pass']),from:date,to:date,reason:z.string().trim().min(5).max(2000),notes:z.string().max(2000).optional(),policy:optionalId,start:time.optional(),end:time.optional()}).refine(v=>v.to>=v.from,'End date must follow start date').parse(req.body);
 const e=await one(c,"SELECT * FROM employees WHERE organization_id=$1 AND id=$2 AND status='Active' FOR UPDATE",[c.org.id,c.member.employee_id]);if(!e)throw new AppError(403,'An active employee profile is required');
 if(await one(c,"SELECT 1 FROM requests WHERE organization_id=$1 AND employee_id=$2 AND kind=$3 AND status IN ('Pending','Approved','Clarification') AND from_date<=$4 AND to_date>=$5",[c.org.id,e.id,d.kind,d.to,d.from]))throw new AppError(409,'An overlapping request already exists');
 let days=0,minutes=0;
 if(d.kind==='Leave'){
  if(!d.policy)throw new AppError(400,'Choose a leave policy');const p=await reference(c,'leave_policies',d.policy);if(!p.active)throw new AppError(400,'Leave policy is inactive');
  if(d.from.slice(0,4)!==d.to.slice(0,4))throw new AppError(400,'Submit separate leave requests for each calendar year');
  const holidays=(await rows(c,'SELECT holiday_date::text AS holiday_day FROM holidays WHERE organization_id=$1 AND holiday_date BETWEEN $2 AND $3',[c.org.id,d.from,d.to])).map(r=>r.holiday_day);
  for(let dt=DateTime.fromISO(d.from);dt<=DateTime.fromISO(d.to);dt=dt.plus({days:1}))if(c.org.workdays.includes(dt.weekday)&&!holidays.includes(dt.toISODate()))days++;
  if(!days)throw new AppError(400,'No working days in this range');
  if(!await one(c,'UPDATE leave_balances SET reserved=reserved+$5 WHERE organization_id=$1 AND employee_id=$2 AND policy_id=$3 AND year=$4 AND allocated-used-reserved>=$5 RETURNING id',[c.org.id,e.id,d.policy,Number(d.from.slice(0,4)),days]))throw new AppError(409,'Insufficient leave balance');
 }else{
  if(d.from!==d.to||!d.start||!d.end)throw new AppError(400,'Choose a single date and start/end times');
  minutes=DateTime.fromISO(`${d.from}T${d.end}`).diff(DateTime.fromISO(`${d.from}T${d.start}`),'minutes').minutes;
  if(minutes<=0||(d.kind==='Hour Pass'&&minutes>120))throw new AppError(400,'Check the time range. Hour Pass is limited to 120 minutes.');
 }
 const r=await one(c,'INSERT INTO requests(organization_id,employee_id,kind,from_date,to_date,reason,details) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',[c.org.id,e.id,d.kind,d.from,d.to,d.reason,JSON.stringify({...d,days,minutes})]);
 await c.db.query("INSERT INTO notifications(organization_id,recipient_membership_id,title,body) SELECT organization_id,id,$2,$3 FROM memberships WHERE organization_id=$1 AND active AND role IN ('owner','admin','hr','approver')",[c.org.id,`New ${d.kind} request`,`${e.name}: ${d.reason}`]);await audit(c,'submit','Request',r.id);return request(r);
});
route('patch','/requests/:id/decision',async(c,req)=>{
 const d=z.object({status:z.enum(['Approved','Rejected','Cancelled','Clarification']),reason:z.string().trim().min(3).max(1000)}).parse(req.body);
 const r=found(await one(c,'SELECT * FROM requests WHERE organization_id=$1 AND id=$2 FOR UPDATE',[c.org.id,req.params.id]),'Request');
 const self=r.employee_id===c.member.employee_id;
 if(d.status==='Cancelled'){if(!self)permit(c,'approvals');}else{permit(c,'approvals');if(self)throw new AppError(403,'You cannot decide your own request');}
 if(['Rejected','Cancelled'].includes(r.status)||(r.status==='Approved'&&d.status!=='Cancelled'))throw new AppError(409,'This request has already been decided');
 if(r.status==='Approved'&&dayString(r.from_date)<DateTime.now().setZone(c.org.timezone).toISODate()!)throw new AppError(409,'Past approved requests require an administrator correction');
 if(r.kind==='Leave'&&d.status!=='Clarification'){
  const amount=Number(r.details.days);
  found(await one(c,'UPDATE leave_balances SET reserved=reserved-$5,used=used+$6 WHERE organization_id=$1 AND employee_id=$2 AND policy_id=$3 AND year=$4 RETURNING id',[c.org.id,r.employee_id,r.details.policy,Number(dayString(r.from_date).slice(0,4)),r.status==='Approved'?0:amount,r.status==='Approved'?-amount:d.status==='Approved'?amount:0]),'Leave allocation');
  await c.db.query('INSERT INTO leave_transactions(organization_id,employee_id,policy_id,request_id,actor_membership_id,amount,kind,reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',[c.org.id,r.employee_id,r.details.policy,r.id,c.member.id,d.status==='Approved'?-amount:r.status==='Approved'?amount:0,d.status,d.reason]);
 }
 if(r.kind==='TimeReconcile'&&d.status==='Approved'){
  const e=await reference(c,'employees',r.employee_id);if(!e.shift_id)throw new AppError(400,'Assign a shift before approving this correction');
  const s=await reference(c,'shifts',e.shift_id),day=dayString(r.from_date);
  const existing=await one(c,'SELECT * FROM attendance WHERE organization_id=$1 AND employee_id=$2 AND work_date=$3',[c.org.id,e.id,day]);
  const policy=existing?.shift_snapshot||shift(s),start=DateTime.fromISO(`${day}T${r.details.start}`,{zone:c.org.timezone}).toJSDate(),end=DateTime.fromISO(`${day}T${r.details.end}`,{zone:c.org.timezone}).toJSDate();
  await c.db.query('INSERT INTO attendance(organization_id,employee_id,work_date,check_in,check_out,shift_snapshot,result) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(organization_id,employee_id,work_date) DO UPDATE SET check_in=excluded.check_in,check_out=excluded.check_out,result=excluded.result',[c.org.id,e.id,day,start,end,JSON.stringify(policy),JSON.stringify(calculate(day,policy,c.org.timezone,start,end))]);
  await audit(c,'approved-correction','Attendance',existing?.id||r.id,{before:existing||null,checkIn:start,checkOut:end});
 }
 await c.db.query('UPDATE requests SET status=$3,details=details || $4::jsonb WHERE organization_id=$1 AND id=$2',[c.org.id,r.id,d.status,JSON.stringify({decisionReason:d.reason,decidedBy:c.member.id,decidedAt:new Date()})]);
 await c.db.query('INSERT INTO notifications(organization_id,recipient_membership_id,title,body) SELECT m.organization_id,m.id,$3,$4 FROM memberships m JOIN employees e ON e.organization_id=m.organization_id AND e.user_id=m.user_id WHERE m.organization_id=$1 AND e.id=$2',[c.org.id,r.employee_id,`${r.kind} ${d.status.toLowerCase()}`,d.reason]);
 await audit(c,d.status,'Request',r.id,{previous:r.status,reason:d.reason});return {message:'Request updated'};
});
route('get','/dashboard',async(c,req)=>{
 const day=date.parse(req.query.date||DateTime.now().setZone(c.org.timezone).toISODate());
 const scope=can(c,'employees')||can(c,'reports')?null:c.member.employee_id||'00000000-0000-4000-8000-000000000000';
 const r=await one(c,`SELECT
   (SELECT json_agg(x) FROM (SELECT * FROM employees WHERE organization_id=$1 AND status='Active' AND ($2::uuid IS NULL OR id=$2)) x) employees,
   (SELECT json_agg(x) FROM (SELECT * FROM attendance WHERE organization_id=$1 AND ($2::uuid IS NULL OR employee_id=$2) AND work_date BETWEEN $3::date-6 AND $3::date) x) attendance,
   (SELECT json_agg(x) FROM (SELECT DISTINCT employee_id FROM requests WHERE organization_id=$1 AND ($2::uuid IS NULL OR employee_id=$2) AND kind='Leave' AND status='Approved' AND from_date<=$3::date AND to_date>=$3::date) x) leaves,
   (SELECT count(*) FROM requests WHERE organization_id=$1 AND ($4::uuid IS NULL OR employee_id=$4) AND status IN ('Pending','Clarification')) pending,
   (SELECT json_agg(x) FROM (SELECT * FROM holidays WHERE organization_id=$1 AND holiday_date>=$3::date ORDER BY holiday_date LIMIT 4) x) holidays,
   (SELECT json_agg(x) FROM (SELECT * FROM announcements WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 4) x) announcements,
   (SELECT json_agg(x) FROM (SELECT * FROM audit_events WHERE organization_id=$1 AND ($5::boolean) ORDER BY created_at DESC LIMIT 5) x) audit`,[c.org.id,scope,day,own(c,'approvals'),can(c,'*')]);
 const es:any[]=r.employees||[],ats:any[]=r.attendance||[],leaves:any[]=r.leaves||[];
 const today=ats.filter(a=>dayString(a.work_date)===day),present=(a:any)=>['Present','Working','Half Day'].includes(a.result.status);
 const trend=Array.from({length:7},(_,i)=>{const d=DateTime.fromISO(day).minus({days:6-i}).toISODate();const a=ats.filter(a=>dayString(a.work_date)===d);return {_id:d,present:a.filter(present).length,late:a.filter(r=>r.result.late).length,absent:a.filter(r=>r.result.status==='Absent').length};});
 return {today:day,total:es.length,present:today.filter(present).length,onLeave:leaves.length,late:today.filter(a=>a.result.late).length,absent:today.filter(a=>a.result.status==='Absent').length,pending:Number(r.pending),newJoiners:es.filter(e=>e.joining_date&&dayString(e.joining_date)>=day.slice(0,7)+'-01').length,departments:es.reduce((out,e)=>({...out,[e.department]:(out[e.department]||0)+1}),{}),trend,recent:((r.audit||[]) as any[]).map(r=>({...base(r),entity:r.entity_type})),holidays:((r.holidays||[]) as any[]).map(r=>({...base(r),date:dayString(r.holiday_date)})),announcements:((r.announcements||[]) as any[]).map(base)};
});
import {S3Client,PutObjectCommand,HeadObjectCommand,GetObjectCommand} from '@aws-sdk/client-s3';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';
import {randomUUID} from 'node:crypto';
const storageConfigured=()=>Boolean(process.env.S3_BUCKET);
const storage=()=>{if(!storageConfigured())throw new AppError(409,'Private document storage has not been configured. Ask your administrator to connect a private S3 bucket.');return new S3Client({region:process.env.S3_REGION||'ap-south-1',...(process.env.S3_ENDPOINT?{endpoint:process.env.S3_ENDPOINT,forcePathStyle:true}:{})});};
route('get','/documents',async c=>({configured:storageConfigured(),items:(await rows(c,'SELECT * FROM documents WHERE organization_id=$1 AND ($2::uuid IS NULL OR employee_id=$2) ORDER BY created_at DESC',[c.org.id,own(c,'documents')])).map(r=>({_id:r.id,name:r.name,size:Number(r.size_bytes),status:r.status}))}));
route('post','/documents/upload',async(c,req)=>{
 const d=z.object({name:z.string().min(2).max(150),mime:z.enum(['application/pdf','image/jpeg','image/png']),size:z.number().int().positive().max(5*1024*1024),employee:optionalId}).parse(req.body);
 const client=storage(),employeeId=can(c,'documents')&&d.employee?d.employee:c.member.employee_id;
 if(!employeeId)throw new AppError(409,'An employee profile is required to upload documents');await reference(c,'employees',employeeId);
 const key=`${c.org.id}/${employeeId}/${randomUUID()}`;
 const url=await getSignedUrl(client,new PutObjectCommand({Bucket:process.env.S3_BUCKET,Key:key,ContentType:d.mime,ContentLength:d.size,ServerSideEncryption:'AES256'}),{expiresIn:120});
 const r=await one(c,"INSERT INTO documents(organization_id,employee_id,name,storage_path,mime_type,size_bytes,status) VALUES ($1,$2,$3,$4,$5,$6,'Uploading') RETURNING id",[c.org.id,employeeId,d.name,key,d.mime,d.size]);return {id:r.id,url};
});
async function documentFor(c:Context,id:string){return found(await one(c,'SELECT * FROM documents WHERE organization_id=$1 AND id=$2 AND ($3::uuid IS NULL OR employee_id=$3)',[c.org.id,id,own(c,'documents')]),'Document');}
route('post','/documents/:id/complete',async(c,req)=>{const d=await documentFor(c,req.params.id);const head=await storage().send(new HeadObjectCommand({Bucket:process.env.S3_BUCKET,Key:d.storage_path}));if(head.ContentLength!==Number(d.size_bytes)||head.ContentType!==d.mime_type)throw new AppError(400,'Uploaded file metadata does not match');await c.db.query("UPDATE documents SET status='Pending Review' WHERE organization_id=$1 AND id=$2",[c.org.id,d.id]);await audit(c,'upload','Document',d.id);return {message:'Document uploaded for review'};});
route('get','/documents/:id/access',async(c,req)=>{const d=await documentFor(c,req.params.id);if(d.status==='Uploading')throw new AppError(409,'Finish the upload before downloading');const url=await getSignedUrl(storage(),new GetObjectCommand({Bucket:process.env.S3_BUCKET,Key:d.storage_path,ResponseContentDisposition:'attachment'}),{expiresIn:60});await audit(c,'access','Document',d.id);return {url};});
route('get','/billing',async c=>{permit(c,'*');const seats=Number((await one(c,"SELECT count(*) n FROM employees WHERE organization_id=$1 AND status='Active'",[c.org.id])).n);return {seats,rate:350,total:seats*350,status:c.org.settings.subscription||'Not subscribed',configured:false,payments:(await rows(c,'SELECT * FROM payment_events WHERE organization_id=$1 ORDER BY received_at DESC',[c.org.id])).map(r=>({_id:r.id,providerId:r.payment_id,amount:Number(r.amount_minor),status:r.status,receivedAt:r.received_at}))};});
route('post','/billing/subscribe',async c=>{permit(c,'*');throw new AppError(409,'Subscription checkout is not connected. No payment has been collected.');});
route('get','/integrations',async c=>{permit(c,'*');return {items:[{id:'database',name:'Workspace database',provider:'Supabase PostgreSQL',configured:true,missing:[],description:'Workspace records are stored in Supabase PostgreSQL.'},{id:'auth',name:'Sign-in and verification',provider:'Supabase Auth',configured:!!process.env.SUPABASE_URL,missing:process.env.SUPABASE_URL?[]:['SUPABASE_URL'],description:'Account verification and password resets are handled by Supabase Auth.'},{id:'storage',name:'Private documents',provider:'S3-compatible storage',configured:storageConfigured(),missing:storageConfigured()?[]:['S3_BUCKET','S3_REGION','AWS credentials'],description:'Private uploads and expiring download links.'},{id:'billing',name:'Subscription checkout',provider:'Not connected',configured:false,missing:[],description:'Checkout is not connected. No payments are being collected.'}]};});
import {createHash,randomBytes} from 'node:crypto';
import {config} from './config';
route('post','/employees/:id/invite',async(c,req)=>{
 permit(c,'employees');const e=await reference(c,'employees',req.params.id);
 if(e.status!=='Active')throw new AppError(409,'Only active employees can be invited');
 if(e.user_id)throw new AppError(409,'This employee already has a linked account');
 const token=randomBytes(32).toString('hex'),hash=createHash('sha256').update(token).digest('hex');
 await c.db.query('UPDATE private.workspace_invitations SET expires_at=now() WHERE organization_id=$1 AND employee_id=$2 AND accepted_at IS NULL',[c.org.id,e.id]);
 await c.db.query("INSERT INTO private.workspace_invitations(organization_id,employee_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '7 days')",[c.org.id,e.id,hash]);
 await audit(c,'create-invitation','Employee',e.id);
 const url=`${config.url}/login?invite=${token}`;
 await sendMail(e.email,`You are invited to ${c.org.name} on People Sync`,`Hello ${e.name},

${c.org.name} has invited you to People Sync, its HR workspace.

Accept your invitation: ${url}

Sign in or create an account with this email address (${e.email}). The invitation link expires in 7 days.`);
 return {url,message:`Invitation email sent to ${e.email}. The link expires in 7 days.`};
});
