import {createClient} from '@supabase/supabase-js';
import {createTokenCache} from './token-cache';

const url=import.meta.env.VITE_SUPABASE_URL;
const publishableKey=import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
export const supabaseEnabled=Boolean(url&&publishableKey);
export const authClient=supabaseEnabled?createClient(url,publishableKey):null;
export const tokenCache=createTokenCache(async()=>{
  if(!authClient)return null;
  let timer:ReturnType<typeof setTimeout>;
  try{
    const result=await Promise.race([
      authClient.auth.getSession(),
      new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Sign-in is taking longer than expected. Please retry.')),10_000);}),
    ]);
    if(result.error)throw new Error(result.error.message||'Please sign in again.');
    return result.data.session?.access_token||null;
  }finally{clearTimeout(timer!);}
},120_000);

export function requireAuthClient(){
  if(!authClient)throw new Error('Sign-in is not configured. Contact your workspace administrator.');
  return authClient;
}

export function checkAuthResult(result:{error?:{message?:string}|null}){
  if(result.error)throw new Error(result.error.message||'Unable to complete sign-in. Please try again.');
}
