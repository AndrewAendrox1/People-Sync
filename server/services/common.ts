import {Audit,Notification,User} from '../models';
export async function audit(req:any,action:string,entity:string,id:any,before?:any,after?:any,session?:any){await Audit.create([{organization:req.org,actor:req.user._id,action,entity,entityId:String(id),before,after}],session?{session}:{});}
export async function notify(org:any,user:any,title:string,body:string,session?:any){await Notification.create([{organization:org,user,title,body}],session?{session}:{});}
export async function notifyAdmins(org:any,title:string,body:string,session?:any){const users=await User.find({organization:org,role:{$in:['owner','admin','hr','approver']},active:true}).session(session||null);for(const user of users)await notify(org,user._id,title,body,session);}

