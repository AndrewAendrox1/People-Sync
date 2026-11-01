import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {MongoMemoryReplSet} from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import {randomBytes} from 'node:crypto';
import {app} from '../server/app';
import {models,Organization,User,Session,Employee,Shift,LeavePolicy,Balance,Request,Audit,Document} from '../server/models';
import {hash} from '../server/middleware';
import {sendMail,requireEmail} from '../server/services/email';
vi.mock('../server/services/email',()=>({sendMail:vi.fn(),requireEmail:vi.fn(),emailTransport:vi.fn()}));
let repl:MongoMemoryReplSet,org:any,other:any,admin:any,employee:any,person:any,policy:any,adminCookie:string,employeeCookie:string,otherCookie:string;
const post=(path:string,cookie:string,body:any)=>request(app).post('/api/v1'+path).set('X-Requested-With','PeopleSync').set('Cookie',cookie).send(body);
const patch=(path:string,cookie:string,body:any)=>request(app).patch('/api/v1'+path).set('X-Requested-With','PeopleSync').set('Cookie',cookie).send(body);
const get=(path:string,cookie:string)=>request(app).get('/api/v1'+path).set('Cookie',cookie);
async function cookie(u:any){const token=randomBytes(32).toString('hex');await Session.create({organization:u.organization,user:u._id,hash:hash(token),expires:new Date(Date.now()+86400000)});return `ps_session=${token}`;}
beforeAll(async()=>{repl=await MongoMemoryReplSet.create({replSet:{count:1,storageEngine:'wiredTiger'}});await mongoose.connect(repl.getUri());await Promise.all(Object.values(models).map(m=>m.init()));org=await Organization.create({name:'First company',code:'FIRST',verified:true});other=await Organization.create({name:'Other company',code:'OTHER',verified:true});const password=await bcrypt.hash('PeopleSync123!',4);admin=await User.create({organization:org._id,name:'Admin',email:'admin@test.example',password,role:'owner',verified:true});const otherAdmin=await User.create({organization:other._id,name:'Other',email:'other@test.example',password,role:'owner',verified:true});const shift=await Shift.create({organization:org._id,name:'Day',code:'DAY',start:'09:00',end:'18:00',secondHalf:'13:30'});person=await Employee.create({organization:org._id,name:'Employee',email:'person@test.example',employeeId:'EMP001',department:'Engineering',shift:shift._id});employee=await User.create({organization:org._id,name:'Employee',email:'person@test.example',password,role:'employee',employee:person._id,verified:true});policy=await LeavePolicy.create({organization:org._id,name:'Casual',code:'CL',entitlement:4});await Balance.create({organization:org._id,employee:person._id,policy:policy._id,year:2027,allocated:4});adminCookie=await cookie(admin);employeeCookie=await cookie(employee);otherCookie=await cookie(otherAdmin);});
afterAll(async()=>{await mongoose.disconnect();await repl?.stop()});
describe('Authentication and isolation',()=>{
it('requires a session',async()=>expect((await get('/employees','')).status).toBe(401));
it('rejects requests without CSRF header',async()=>expect((await request(app).post('/api/v1/auth/login').send({})).status).toBe(403));
it('rejects untrusted origins',async()=>expect((await request(app).post('/api/v1/auth/login').set('X-Requested-With','PeopleSync').set('Origin','https://evil.example').send({})).status).toBe(403));
it('returns the authenticated server-side role',async()=>{const r=await post('/auth/login','',{email:'person@test.example',password:'PeopleSync123!'});expect(r.status).toBe(200);expect(r.body.user.role).toBe('employee');expect(r.headers['set-cookie'][0]).toContain('HttpOnly')});
it('blocks employee admin APIs',async()=>{expect((await get('/employees',employeeCookie)).status).toBe(403);expect((await get('/settings',employeeCookie)).status).toBe(403);expect((await get('/billing',employeeCookie)).status).toBe(403)});
it('never exposes another tenant employee',async()=>expect((await get('/employees/'+person._id,otherCookie)).status).toBe(404));
it('ignores a forged tenant query parameter',async()=>{const r=await get('/employees?organization='+org._id,otherCookie);expect(r.body.items).toHaveLength(0)});
it('blocks protected profile edits',async()=>expect((await patch('/employees/me',employeeCookie,{department:'Leadership',role:'owner'})).status).toBe(400));
it('allows safe personal changes',async()=>expect((await patch('/employees/me',employeeCookie,{phone:'+91 9000000000'})).status).toBe(200));
it('blocks cross-tenant document access',async()=>{const d=await Document.create({organization:org._id,employee:person._id,key:'private',name:'Identity',status:'Pending Review'});expect((await get('/documents/'+d._id+'/access',otherCookie)).status).toBe(404)});
it('rejects duplicate company codes atomically',async()=>{const r=await post('/auth/register','',{name:'New Owner',email:'new@test.example',password:'PeopleSync123!',company:'Duplicate',code:'FIRST',terms:true});expect(r.status).toBe(409);expect(await User.exists({email:'new@test.example'})).toBeNull()});
it('rejects duplicate email without orphaning an organization',async()=>{const r=await post('/auth/register','',{name:'New Owner',email:'admin@test.example',password:'PeopleSync123!',company:'Duplicate',code:'DUPLICATE',terms:true});expect(r.status).toBe(409);expect(await Organization.exists({code:'DUPLICATE'})).toBeNull()});
it('registers an unverified owner and default policies',async()=>{const r=await post('/auth/register','',{name:'New Owner',email:'newowner@test.example',password:'PeopleSync123!',company:'New Company',code:'NEWCO',terms:true,role:'employee'});expect(r.status).toBe(201);const u=await User.findOne({email:'newowner@test.example'});expect(u?.role).toBe('owner');expect(u?.verified).toBe(false);expect((await post('/auth/login','',{email:u?.email,password:'PeopleSync123!'})).status).toBe(403)});
it('creates an employee, allocation and onboarding tasks',async()=>{const r=await post('/employees',adminCookie,{name:'New Person',email:'newperson@test.example',department:'Design',joiningDate:'2026-10-26'});expect(r.status).toBe(201);expect(r.body.employeeId).toBe('EMP0001');expect(await models.Onboarding.countDocuments({employee:r.body._id})).toBe(3)});
it('blocks foreign shift assignment',async()=>{const s=await Shift.create({organization:other._id,name:'Other',code:'OTHER'});expect((await patch('/employees/'+person._id,adminCookie,{shift:String(s._id)})).status).toBe(400)});
});
describe('Leave and approvals',()=>{let reqId:string;
it('reserves leave on submission',async()=>{const r=await post('/requests',employeeCookie,{kind:'Leave',from:'2027-01-04',to:'2027-01-05',policy:String(policy._id),reason:'Family commitment'});expect(r.status).toBe(201);reqId=r.body._id;expect(r.body.days).toBe(2);expect((await Balance.findOne({employee:person._id,year:2027}))?.reserved).toBe(2)});
it('prevents overlapping leave',async()=>expect((await post('/requests',employeeCookie,{kind:'Leave',from:'2027-01-05',to:'2027-01-06',policy:String(policy._id),reason:'Another commitment'})).status).toBe(409));
it('prevents negative balances',async()=>expect((await post('/requests',employeeCookie,{kind:'Leave',from:'2027-01-11',to:'2027-01-15',policy:String(policy._id),reason:'Long vacation'})).status).toBe(409));
it('blocks unauthorized approvals',async()=>expect((await patch(`/requests/${reqId}/decision`,employeeCookie,{status:'Approved',reason:'Self approval'})).status).toBe(403));
it('deducts leave exactly once on approval',async()=>{expect((await patch(`/requests/${reqId}/decision`,adminCookie,{status:'Approved',reason:'Approved by manager'})).status).toBe(200);const b=await Balance.findOne({employee:person._id,year:2027});expect(b?.used).toBe(2);expect(b?.reserved).toBe(0);expect((await patch(`/requests/${reqId}/decision`,adminCookie,{status:'Approved',reason:'Duplicate decision'})).status).toBe(409)});
it('restores approved leave on cancellation',async()=>{expect((await patch(`/requests/${reqId}/decision`,employeeCookie,{status:'Cancelled',reason:'Plans have changed'})).status).toBe(200);expect((await Balance.findOne({employee:person._id,year:2027}))?.used).toBe(0)});
it('calculates permission minutes and enforces the limit',async()=>{const r=await post('/requests',employeeCookie,{kind:'Hour Pass',from:'2027-01-06',to:'2027-01-06',start:'10:00',end:'11:30',reason:'Personal appointment'});expect(r.status).toBe(201);expect(r.body.minutes).toBe(90);expect((await post('/requests',employeeCookie,{kind:'Hour Pass',from:'2027-01-07',to:'2027-01-07',start:'10:00',end:'14:00',reason:'Personal appointment'})).status).toBe(400)});
it('creates auditable decisions',async()=>expect(await Audit.countDocuments({organization:org._id,action:'Approved'})).toBeGreaterThan(0));
it('does not expose private sent requests to a second tenant',async()=>expect((await get('/requests',otherCookie)).body.items).toHaveLength(0));
});

describe('Integration configuration visibility',()=>{
 it('denies employee access',async()=>expect((await get('/integrations',employeeCookie)).status).toBe(403));
 it('returns configuration names without secret values',async()=>{
  const old=process.env.RAZORPAY_KEY_SECRET;process.env.RAZORPAY_KEY_SECRET='private-test-secret';
  try{const r=await get('/integrations',adminCookie);expect(r.status).toBe(200);expect(r.body.items).toHaveLength(3);expect(JSON.stringify(r.body)).not.toContain('private-test-secret');}finally{if(old===undefined)delete process.env.RAZORPAY_KEY_SECRET;else process.env.RAZORPAY_KEY_SECRET=old;}
 });
});

describe('Related record display',()=>{
 it('resolves onboarding employee names',async()=>{const r=await get('/people-start',adminCookie);expect(r.status).toBe(200);expect(r.body.items.length).toBeGreaterThan(0);expect(r.body.items[0].employee.name).toBeTruthy();});
 it('resolves leave policy and employee labels',async()=>{const r=await get('/leaves/balances',adminCookie);expect(r.status).toBe(200);expect(r.body.items[0].policy.name).toBeTruthy();expect(r.body.items[0].employee.name).toBeTruthy();});
});

describe('Invitation recovery',()=>{
 it('does not create an account when email configuration is missing',async()=>{
  const e=await Employee.create({organization:org._id,name:'No Mail',email:'nomail@test.example',employeeId:'MAIL001'});
  vi.mocked(requireEmail).mockImplementationOnce(()=>{throw Object.assign(new Error('Email is not configured'),{status:503});});
  expect((await post(`/employees/${e._id}/invite`,adminCookie,{})).status).toBe(503);
  expect(await User.exists({employee:e._id})).toBeNull();
 });
 it('allows retry after a provider failure without creating duplicate accounts',async()=>{
  const e=await Employee.create({organization:org._id,name:'Retry Person',email:'retry@test.example',employeeId:'MAIL002'});
  vi.mocked(sendMail).mockRejectedValueOnce(Object.assign(new Error('Provider unavailable'),{status:503}));
  expect((await post(`/employees/${e._id}/invite`,adminCookie,{})).status).toBe(503);
  expect((await post(`/employees/${e._id}/invite`,adminCookie,{})).status).toBe(200);
  expect(await User.countDocuments({employee:e._id})).toBe(1);
 });
 it('does not replace credentials for activated employees',async()=>expect((await post(`/employees/${person._id}/invite`,adminCookie,{})).status).toBe(409));
});
