import {useEffect,useState} from 'react';
import {Link,useNavigate} from 'react-router-dom';
import {Brand} from './Brand';
import {Form,type Field} from './Form';
import {requireAuthClient,checkAuthResult,tokenCache} from '../auth';
import {api,send} from '../api';
import {normalizeOtp,verifyEmailOnce} from '../otp';

export function SupabaseAuth({mode,onReady}:{mode:string;onReady:(session?:any)=>Promise<void>}){
  const navigate=useNavigate();
  const [step,setStep]=useState(mode),[address,setAddress]=useState(''),[notice,setNotice]=useState(''),[resending,setResending]=useState(false);
  useEffect(()=>{setStep(mode);setNotice('');},[mode]);
  useEffect(()=>{const token=new URLSearchParams(window.location.search).get('invite');if(token&&/^[a-f0-9]{64}$/.test(token)){sessionStorage.setItem('people-sync-invitation',token);window.history.replaceState(null,'',window.location.pathname);setNotice('Sign in or create an account using your invited employee email to join your workspace.');}},[]);
  const client=requireAuthClient();
  const finish=async()=>{
    const invitation=sessionStorage.getItem('people-sync-invitation');
    const session=invitation?await send('/auth/accept-invitation',{token:invitation}):await api('/auth/me');
    if(invitation)sessionStorage.removeItem('people-sync-invitation');
    if(session.needsWorkspace){setStep('setup');return;}
    await onReady(session);navigate('/app/dashboard',{replace:true});
  };
  const titles:Record<string,[string,string]>={
    login:['Welcome back','Sign in to your People Sync account.'],
    signup:['Create your account','Verify your email, then create your company workspace.'],
    verify:['Check your email','Enter the verification code sent to your email address.'],
    'resend-verification':['Verify your email','Request a fresh verification code.'],
    forgot:['Reset your password','We’ll send a code to your registered email address.'],
    reset:['Choose a new password','Enter the code from your email and your new password.'],
    setup:['Create your workspace','Your account is verified. Add your company details to finish.'],
  };
  const [title,subtitle]=titles[step]||titles.login;
  const emailField:Field={name:'email',label:'Email address',type:'email'};
  const passwordField:Field={name:'password',label:'Password',type:'password'};
  const fields:Field[]=step==='signup'?[{name:'name',label:'Full name'},emailField,{...passwordField,label:'Password (12+ characters, uppercase, lowercase and number)'},{name:'confirm',label:'Confirm password',type:'password'},{name:'terms',label:'I agree to the terms and privacy notice',type:'checkbox'}]
    :step==='verify'?[emailField,{name:'otp',label:'Verification code'}]
    :step==='forgot'||step==='resend-verification'?[emailField]
    :step==='reset'?[emailField,{name:'otp',label:'Reset code'},{...passwordField,label:'New password (12+ characters, uppercase, lowercase and number)'},{name:'confirm',label:'Confirm new password',type:'password'}]
    :step==='setup'?[{name:'company',label:'Company name'},{name:'code',label:'Company code (3–20 letters, numbers or hyphens)'},{name:'terms',label:'I agree to the terms and privacy notice',type:'checkbox'}]
    :[emailField,passwordField];
  const submit=async(data:Record<string,any>)=>{
    setNotice('');
    const email=String(data.email||address).trim().toLowerCase();setAddress(email);
    if(['signup','reset'].includes(step)){
      if(data.password!==data.confirm)throw new Error('Passwords do not match.');
      if(!/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{12,128}$/.test(data.password))throw new Error('Use 12–128 characters with uppercase, lowercase and a number.');
    }
    if(step==='signup'){
      if(!data.terms)throw new Error('Accept the terms and privacy notice to continue.');
      const result=await client.auth.signUp({email,password:data.password,options:{data:{name:data.name},emailRedirectTo:`${window.location.origin}/login`}});
      checkAuthResult(result);
      if(result.data.session){tokenCache.clear();await finish();return;}
      setStep('verify');setNotice('A verification code has been sent. Check your inbox and spam folder.');
    }else if(step==='login'){
      const result=await client.auth.signInWithPassword({email,password:data.password});
      if(result.error?.code==='email_not_confirmed'){setStep('verify');setNotice('Verify your email to continue. Use Resend code if needed.');return;}
      checkAuthResult(result);tokenCache.clear();await finish();
    }else if(step==='verify'){
      const otp=normalizeOtp(data.otp);
      await verifyEmailOnce(()=>client.auth.verifyOtp({email,token:otp,type:'signup'}),async()=>{tokenCache.clear();await finish();});
    }else if(step==='forgot'){
      checkAuthResult(await client.auth.resetPasswordForEmail(email,{redirectTo:`${window.location.origin}/reset`}));
      setStep('reset');setNotice('If this account exists, a reset code has been requested.');
    }else if(step==='reset'){
      checkAuthResult(await client.auth.verifyOtp({email,token:normalizeOtp(data.otp),type:'recovery'}));
      checkAuthResult(await client.auth.updateUser({password:data.password}));
      await client.auth.signOut();tokenCache.clear();
      setStep('login');setNotice('Password updated. Sign in with your new password.');
    }else if(step==='resend-verification'){
      checkAuthResult(await client.auth.resend({type:'signup',email,options:{emailRedirectTo:`${window.location.origin}/login`}}));
      setStep('verify');setNotice('If this account needs verification, a code has been requested.');
    }else if(step==='setup'){
      const session=await send('/auth/workspace',data);await onReady(session);navigate('/app/dashboard',{replace:true});
    }
  };
  return <div className="auth-layout"><section className="auth-form">
    <Brand/>
    <div><span className="eyebrow">YOUR PEOPLE. YOUR WORKSPACE.</span><h1>{title}</h1><p>{subtitle}</p>
      {notice&&<div className="notice" role="status">{notice}</div>}
      <Form key={step} fields={fields} initial={{email:address}} onSubmit={submit} submit={step==='login'?'Sign in':step==='signup'?'Create account':step==='setup'?'Create workspace':step==='verify'?'Verify email':step==='reset'?'Save password':'Send code'}/>
      {step==='verify'&&<button className="forgot" disabled={resending} onClick={async()=>{setResending(true);try{if(!address)throw new Error('Enter your email on the resend verification page.');checkAuthResult(await client.auth.resend({type:'signup',email:address,options:{emailRedirectTo:`${window.location.origin}/login`}}));setNotice('A fresh code has been requested.');}catch(error){setNotice(error instanceof Error?error.message:'Unable to resend code.');}finally{setResending(false);}}}>{resending?'Sending…':'Resend code'}</button>}
      {step==='login'&&<><Link className="forgot" to="/forgot">Forgot password?</Link><Link className="forgot" to="/resend-verification">Verify your email</Link><p className="field-optional">Use the verified email address associated with your People Sync account or invitation.</p></>}
      <p className="auth-switch"><Link to="/terms">Terms</Link> · <Link to="/privacy">Privacy notice</Link></p>
      <div className="auth-divider"/><p className="auth-switch">{step==='login'?<>New to People Sync? <Link to="/signup">Create an account</Link></>:<Link to="/login" onClick={()=>setStep('login')}>Back to sign in</Link>}</p>
      {step==='setup'&&<button className="forgot" onClick={async()=>{checkAuthResult(await client.auth.signOut());tokenCache.clear();await onReady();navigate('/login');}}>Sign out</button>}
    </div><small>© {new Date().getFullYear()} People Sync</small>
  </section><section className="auth-art"><span className="art-label">PEOPLE SYNC</span><h2>A clear start.<br/>A connected team.</h2><p>Your people and their work, together in one workspace.</p></section></div>;
}
