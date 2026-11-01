import {Router} from 'express';
import {z} from 'zod';
import bcrypt from 'bcryptjs';
import {randomBytes} from 'node:crypto';
import mongoose from 'mongoose';
import {rateLimit} from 'express-rate-limit';
import {Organization,User,Session,Shift,LeavePolicy} from '../models';
import {wrap,HttpError,hash,auth} from '../middleware';
import {email,password} from '../validation';
import {config} from '../config';
import {sendMail,requireEmail} from '../services/email';
export const authRoutes=Router();
authRoutes.use(rateLimit({windowMs:15*60*1000,limit:40,standardHeaders:'draft-8',legacyHeaders:false}));
const account=z.object({name:z.string().min(2).max(100),email,password,company:z.string().min(2).max(150),code:z.string().min(3,'Use at least 3 characters').max(20,'Use no more than 20 characters').regex(/^[a-zA-Z0-9-]+$/,'Use only letters, numbers, and hyphens (for example BOOSTER-111); dots and spaces are not allowed').transform(v=>v.toUpperCase()),terms:z.literal(true)});
const safe=(u:any)=>({id:u._id,name:u.name,email:u.email,role:u.role,organization:u.organization,employee:u.employee});
async function issueSession(user:any,res:any,remember=false){const token=randomBytes(32).toString('hex');const maxAge=(remember?30:1)*86400000;await Session.create({organization:user.organization,user:user._id,hash:hash(token),expires:new Date(Date.now()+maxAge)});res.cookie('ps_session',token,{httpOnly:true,secure:config.production,sameSite:'lax',path:'/',maxAge});}
authRoutes.post('/register',wrap(async(req,res)=>{requireEmail();const data=account.parse(req.body);const token=randomBytes(32).toString('hex');const encrypted=await bcrypt.hash(data.password,12);await mongoose.connection.transaction(async session=>{const [org]=await Organization.create([{name:data.company,code:data.code,email:data.email}],{session,ordered:true});await User.create([{organization:org._id,name:data.name,email:data.email,password:encrypted,role:'owner',tokenHash:hash(token),tokenPurpose:'verify',tokenExpires:new Date(Date.now()+86400000)}],{session,ordered:true});await Shift.create([{organization:org._id,name:'Morning Shift',code:'MORNING',start:'09:00',end:'18:00',secondHalf:'13:30'}],{session,ordered:true});await LeavePolicy.create([{organization:org._id,name:'Casual Leave',code:'CL',entitlement:4},{organization:org._id,name:'Sick Leave',code:'SL',entitlement:7}],{session,ordered:true});});await sendMail(data.email,'Verify your People Sync account',`${config.url}/verify?token=${token}`);res.status(201).json({message:'Check your email to verify your account.'});}));
authRoutes.post('/resend-verification',wrap(async(req,res)=>{
  const address=email.parse(req.body.email);requireEmail();
  const u=await User.findOne({email:address,active:true,verified:false});
  if(u){
    const token=randomBytes(32).toString('hex');
    await User.updateOne({_id:u._id},{$set:{tokenHash:hash(token),tokenPurpose:'verify',tokenExpires:new Date(Date.now()+86400000)}});
    await sendMail(address,'Verify your People Sync account',`${config.url}/verify?token=${token}`);
  }
  res.json({message:'If this account needs verification, a new link has been sent. Check your inbox and spam folder.'});
}));
authRoutes.post('/verify',wrap(async(req,res)=>{const token=z.string().min(20).parse(req.body.token);const u=await User.findOneAndUpdate({tokenHash:hash(token),tokenPurpose:'verify',tokenExpires:{$gt:new Date()}},{$set:{verified:true},$unset:{tokenHash:1,tokenPurpose:1,tokenExpires:1}},{returnDocument:'after'});if(!u)throw new HttpError(400,'Verification link is invalid or expired');await Organization.updateOne({_id:u.organization},{$set:{verified:true}});await issueSession(u,res);res.json({user:safe(u)});}));
authRoutes.post('/login',wrap(async(req,res)=>{const data=z.object({email,password:z.string().max(128),remember:z.boolean().optional()}).parse(req.body);const u=await User.findOne({email:data.email,active:true}).select('+password');if(!u||!await bcrypt.compare(data.password,u.password!))throw new HttpError(401,'Email or password is incorrect');if(!u.verified)throw new HttpError(403,'Please verify your email first');await issueSession(u,res,data.remember);res.json({user:safe(u)});}));
authRoutes.get('/me',auth,wrap(async(req,res)=>res.json({user:safe(req.user),organization:await Organization.findById(req.org)})));
authRoutes.post('/logout',auth,wrap(async(req,res)=>{await Session.deleteOne({hash:hash(req.cookies.ps_session)});res.clearCookie('ps_session',{path:'/',httpOnly:true,secure:config.production,sameSite:'lax'});res.json({message:'Signed out'});}));
authRoutes.post('/forgot',wrap(async(req,res)=>{requireEmail();const address=email.parse(req.body.email);const u=await User.findOne({email:address,active:true});if(u){const token=randomBytes(32).toString('hex');await User.updateOne({_id:u._id},{$set:{tokenHash:hash(token),tokenPurpose:'reset',tokenExpires:new Date(Date.now()+3600000)}});await sendMail(address,'Reset your People Sync password',`${config.url}/reset?token=${token}`);}res.json({message:'If an account exists, a reset link has been sent.'});}));
authRoutes.post('/reset',wrap(async(req,res)=>{const data=z.object({token:z.string().min(20),password}).parse(req.body);const u=await User.findOneAndUpdate({tokenHash:hash(data.token),tokenPurpose:{$in:['reset','invite']},tokenExpires:{$gt:new Date()}},{$set:{password:await bcrypt.hash(data.password,12),verified:true},$unset:{tokenHash:1,tokenPurpose:1,tokenExpires:1}},{returnDocument:'after'});if(!u)throw new HttpError(400,'Reset link is invalid or expired');await Session.deleteMany({user:u._id});res.json({message:'Password saved. You can now sign in.'});}));

