import {authClient,tokenCache} from './auth';
export class ApiError extends Error {
  constructor(message:string,public status:number,public fields:Record<string,string>={}){super(message);}
}
export async function api(path:string,options:RequestInit={}){
  const request=async()=>{
    const headers = new Headers(options.headers);
    headers.set('Content-Type','application/json');
    headers.set('X-Requested-With','PeopleSync');
    if(authClient){
      const tokenStart=performance.now();
      const token=await tokenCache.get();
      if(import.meta.env.DEV)headers.set('X-Client-Token-Ms',String(Math.round(performance.now()-tokenStart)));
      if(token)headers.set('Authorization',`Bearer ${token}`);
    }
    try{return await fetch(`/api/v1${path}`,{credentials:'include',...options,signal:options.signal??AbortSignal.timeout(12_000),headers});}
    catch{throw new ApiError('Unable to reach People Sync. Check your connection and try again.',0);}
  };
  let response=await request();
  if(response.status===401&&authClient){tokenCache.clear();response=await request();}
  const data=await response.json().catch(()=>null);
  if(!response.ok){
    if(response.status===401)tokenCache.clear();
    const fields:Record<string,string>={};
    for(const issue of Array.isArray(data?.details)?data.details:[]){const key=issue.path?.join('.');if(key)fields[key]=[fields[key],issue.message].filter(Boolean).join('. ');}
    throw new ApiError(Object.keys(fields).length?'Review the highlighted fields.':data?.error||(response.status>=500?'People Sync is temporarily unavailable. Please try again shortly.':`Request failed (${response.status}). Please try again.`),response.status,fields);
  }
  return data;
}
export const send=(path:string,data:unknown,method='POST')=>api(path,{method,body:JSON.stringify(data)});
export function csv(name:string,rows:Record<string,unknown>[]){if(!rows.length)return;const keys=Object.keys(rows[0]);const escape=(v:unknown)=>{let s=String(v??'');if(/^[=+@\-]/.test(s))s="'"+s;return `"${s.replaceAll('"','""')}"`;};const blob=new Blob([[keys.map(escape).join(','),...rows.map(r=>keys.map(k=>escape(r[k])).join(','))].join('\r\n')],{type:'text/csv;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`${name}.csv`;a.click();URL.revokeObjectURL(url);}
