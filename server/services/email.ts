import nodemailer from 'nodemailer';
import {HttpError} from '../middleware';
export function requireEmail(){
  if(!process.env.SMTP_HOST || !process.env.EMAIL_FROM || ((process.env.SMTP_USER || process.env.SMTP_HOST==='smtp.gmail.com') && (!process.env.SMTP_USER || !process.env.SMTP_PASS))) throw new HttpError(503,'Email delivery is not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS, and EMAIL_FROM, then try again.');
}
export async function sendMail(to:string,subject:string,text:string){
  requireEmail();
  const transport=emailTransport();
  try {
    const result=await transport.sendMail({from:process.env.EMAIL_FROM,to,subject,text});
    if(!result.accepted?.length)throw new Error('Recipient not accepted');
  } catch {
    throw new HttpError(503,'The email provider could not accept the message. Check the SMTP credentials and sender address, then try again.');
  }
}

export const emailTransport=()=>nodemailer.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||587),secure:process.env.SMTP_PORT==='465',auth:process.env.SMTP_USER?{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}:undefined ,connectionTimeout:10000,greetingTimeout:10000,socketTimeout:15000});
