import {Router} from 'express';
import {permit,wrap,HttpError} from '../middleware';
import {emailTransport,requireEmail} from '../services/email';
export const integrationRoutes=Router();
integrationRoutes.use(permit('*'));
integrationRoutes.get('/',wrap(async(req,res)=>{
 const emailKeys=['SMTP_HOST','EMAIL_FROM',...(process.env.SMTP_USER||process.env.SMTP_HOST==='smtp.gmail.com'?['SMTP_USER','SMTP_PASS']:[])];
 const definitions=[
  {id:'email',name:'Transactional email',provider:process.env.SMTP_HOST==='smtp.gmail.com'?'Gmail / Google Workspace':'SMTP',description:'Account verification, invitations, and password recovery.',keys:emailKeys},
  {id:'storage',name:'Private documents',provider:'Amazon S3',description:'Private employee documents with expiring download links. Uses the server AWS credential chain.',keys:['S3_BUCKET','S3_REGION']},
  {id:'billing',name:'Subscriptions',provider:'Razorpay',description:'Recurring subscriptions and signed payment notifications.',keys:['RAZORPAY_KEY_ID','RAZORPAY_KEY_SECRET','RAZORPAY_PLAN_ID','RAZORPAY_WEBHOOK_SECRET']}
 ];
 res.json({items:definitions.map(({keys,...item})=>{const missing=keys.filter(k=>!process.env[k]?.trim());return {...item,configured:missing.length===0,missing};})});
}));
integrationRoutes.post('/email/check',wrap(async(req,res)=>{
 requireEmail();
 try{await emailTransport().verify();}catch{throw new HttpError(503,'Email connection failed. Check the host, port, sender account, and app password.');}
 res.json({message:'Email server connection and authentication succeeded. No email was sent.'});
}));
