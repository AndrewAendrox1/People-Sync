import {Router} from 'express';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import {randomBytes} from 'node:crypto';
import {z} from 'zod';
import {Employee,Organization,User,Shift,Balance,LeavePolicy,Onboarding,Session} from '../models';
import {wrap,permit,scope,own,HttpError,hash} from '../middleware';
import {employeeSchema} from '../validation';
import {audit} from '../services/common';
import {sendMail,requireEmail} from '../services/email';
import {config} from '../config';
export const employeeRoutes=Router();
employeeRoutes.get('/',permit('employees'),wrap(async(req,res)=>{const page=Math.max(1,Number(req.query.page)||1);const filter:any={...scope(req)};if(req.query.status)filter.status=String(req.query.status);if(req.query.department)filter.department=String(req.query.department);if(req.query.q)filter.name={$regex:String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),$options:'i'};res.json({items:await Employee.find(filter).sort({name:1}).skip((page-1)*20).limit(20),total:await Employee.countDocuments(filter),page});}));
employeeRoutes.get('/me',wrap(async(req,res)=>res.json(await Employee.findOne({...scope(req),_id:req.user.employee||null}))));
employeeRoutes.patch('/me',wrap(async(req,res)=>{const data=z.object({phone:z.string().max(30).optional(),address:z.string().max(500).optional(),emergencyContact:z.string().max(200).optional(),education:z.string().max(1000).optional(),experience:z.string().max(2000).optional()}).strict().parse(req.body);const e=await Employee.findOneAndUpdate({...scope(req),_id:req.user.employee||null},{$set:data},{returnDocument:'after'});if(!e)throw new HttpError(404,'Employee profile not found');await audit(req,'update-own-profile','Employee',e._id);res.json(e);}));
employeeRoutes.get('/:id',wrap(async(req,res)=>{const e=await Employee.findOne({...own(req,'employees'),_id:req.params.id});if(!e)throw new HttpError(404,'Employee not found');res.json(e);}));
employeeRoutes.post('/',permit('employees'),wrap(async(req,res)=>{const data=employeeSchema.parse(req.body);if(data.shift&&!await Shift.exists({...scope(req),_id:data.shift}))throw new HttpError(400,'Shift not found');if(data.manager&&!await Employee.exists({...scope(req),_id:data.manager}))throw new HttpError(400,'Manager not found');let result:any;await mongoose.connection.transaction(async session=>{const org=await Organization.findOneAndUpdate({_id:req.org},{$inc:{employeeSequence:1}},{returnDocument:'after',session});[result]=await Employee.create([{...data,organization:req.org,employeeId:`EMP${String(org!.employeeSequence).padStart(4,'0')}`}],{session,ordered:true});const policies=await LeavePolicy.find({...scope(req),active:true}).session(session);for(const p of policies)await Balance.create([{organization:req.org,employee:result._id,policy:p._id,year:new Date().getFullYear(),allocated:p.entitlement}],{session,ordered:true});await Onboarding.create(['Complete personal information','Upload required documents','Review company handbook'].map(title=>({organization:req.org,employee:result._id,title,status:'Not Started'})),{session,ordered:true});await audit(req,'create','Employee',result._id,undefined,data,session);});res.status(201).json(result);}));
employeeRoutes.patch('/:id',permit('employees'),wrap(async(req,res)=>{const data=employeeSchema.partial().parse(req.body);if(data.shift&&!await Shift.exists({...scope(req),_id:data.shift}))throw new HttpError(400,'Shift not found');if(data.manager&&!await Employee.exists({...scope(req),_id:data.manager}))throw new HttpError(400,'Manager not found');const before=await Employee.findOne({...scope(req),_id:req.params.id});if(!before)throw new HttpError(404,'Employee not found');const e=await Employee.findOneAndUpdate({_id:before._id},{$set:data},{returnDocument:'after'});if(data.status&&data.status!=='Active'){await User.updateOne({employee:e!._id,organization:req.org},{$set:{active:false}});await Session.deleteMany({user:e!.user,organization:req.org});}await audit(req,'update','Employee',e!._id,before.toObject(),data);res.json(e);}));
employeeRoutes.delete('/:id',permit('employees'),wrap(async(req,res)=>{const e=await Employee.findOneAndUpdate({...scope(req),_id:req.params.id},{$set:{status:'Exited'}},{returnDocument:'after'});if(!e)throw new HttpError(404,'Employee not found');await User.updateOne({employee:e._id,organization:req.org},{$set:{active:false}});await Session.deleteMany({user:e.user,organization:req.org});await audit(req,'archive','Employee',e._id);res.json(e);}));
employeeRoutes.post('/:id/invite',permit('employees'),wrap(async(req,res)=>{
 requireEmail();
 const e=await Employee.findOne({...scope(req),_id:req.params.id,status:'Active'});
 if(!e)throw new HttpError(404,'Active employee not found');
 const token=randomBytes(32).toString('hex');
 let u=await User.findOne({...scope(req),employee:e._id});
 if(u?.verified)throw new HttpError(409,'This employee has already activated their account');
 if(u){
  await User.updateOne({_id:u._id,organization:req.org},{$set:{tokenHash:hash(token),tokenPurpose:'invite',tokenExpires:new Date(Date.now()+7*86400000)}});
 }else{
  await mongoose.connection.transaction(async session=>{
   [u]=await User.create([{organization:req.org,employee:e._id,name:e.name,email:e.email,password:await bcrypt.hash(randomBytes(32).toString('hex'),12),role:'employee',tokenHash:hash(token),tokenPurpose:'invite',tokenExpires:new Date(Date.now()+7*86400000)}],{session,ordered:true});
   await Employee.updateOne({_id:e._id,organization:req.org},{$set:{user:u!._id}},{session});
  });
 }
 await sendMail(e.email!,'You are invited to People Sync',`${config.url}/reset?token=${token}`);
 await audit(req,'invite','Employee',e._id);
 res.json({message:'Invitation sent'});
}));
