import type {Request,Response,NextFunction} from 'express';
import {createHash} from 'node:crypto';
import {Session,User} from './models';
export const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
export class HttpError extends Error {constructor(public status:number,message:string){super(message);}}
export const wrap=(fn:(req:any,res:Response,next:NextFunction)=>any)=>(req:Request,res:Response,next:NextFunction)=>Promise.resolve(fn(req,res,next)).catch(next);
export const permissions:Record<string,string[]>={owner:['*'],admin:['*'],hr:['employees','onboarding','leaves','approvals','reports','documents'],attendance:['attendance','shifts','reports'],approver:['approvals'],project:['projects'],employee:[]};
export const auth=wrap(async(req,res,next)=>{const raw=req.cookies.ps_session;if(!raw)throw new HttpError(401,'Please sign in');const session=await Session.findOne({hash:hash(raw),expires:{$gt:new Date()}});if(!session)throw new HttpError(401,'Your session has expired');const user=await User.findOne({_id:session.user,organization:session.organization,active:true,verified:true});if(!user)throw new HttpError(401,'Account unavailable');req.user=user;req.org=user.organization;next();});
export const allowed=(user:any,permission:string)=>permissions[user.role]?.some(x=>x==='*'||x===permission);
export const permit=(permission:string)=>wrap(async(req,res,next)=>{if(!allowed(req.user,permission))throw new HttpError(403,'You do not have permission for this action');next();});
export const scope=(req:any)=>({organization:req.org});
export const own=(req:any,permission:string)=>allowed(req.user,permission)?scope(req):{...scope(req),employee:req.user.employee||null};
export function errorHandler(error:any,req:Request,res:Response,next:NextFunction){if(error.name==='ZodError'){res.status(400).json({error:'Please check the form',details:error.issues});return;}if(error.code===11000){res.status(409).json({error:'This record already exists'});return;}if(error.name==='CastError'){res.status(400).json({error:'Invalid record identifier'});return;}if(!error.status)console.error(error.message);res.status(error.status||500).json({error:error.status?error.message:'An unexpected error occurred'});}

