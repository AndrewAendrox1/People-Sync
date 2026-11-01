import {useEffect,useState} from 'react';
import {api,send} from '../api';
export function Integrations(){
 const [data,setData]=useState<any>(null),[error,setError]=useState(''),[checking,setChecking]=useState(false),[result,setResult]=useState('');
 const load=()=>{setError('');api('/integrations').then(setData).catch(e=>setError(e.message));};
 useEffect(load,[]);
 return <><div className="page-heading"><div><div className="eyebrow">WORKSPACE SETTINGS</div><h1>Integrations</h1><p>Check the services behind your daily workflows.</p></div><button onClick={load}>Refresh status</button></div>
 <div className="notice">Configuration status shows which workspace services are connected. Account emails are managed by Supabase Auth.</div>
 {error&&<div role="alert" className="error">{error}</div>}
 {!data&&!error&&<p role="status">Loading integrations…</p>}
 <div className="integration-grid">{data?.items.map((item:any)=><section className="panel integration-card" key={item.id}><div className="integration-heading"><h2>{item.name}</h2><span className={`badge ${item.configured?'green':'amber'}`}>{item.configured?'Configured':'Setup required'}</span></div><p>{item.description}</p><dl><dt>Provider</dt><dd>{item.provider}</dd></dl>{item.missing.length>0&&<div className="integration-missing"><b>Required server settings</b><code>{item.missing.join(', ')}</code></div>}{item.id==='email'&&<button disabled={!item.configured||checking} onClick={async()=>{setChecking(true);setResult('');try{const r=await send('/integrations/email/check',{});setResult(r.message);}catch(e:any){setResult(e.message);}finally{setChecking(false);}}}>{checking?'Checking connection…':'Check email connection'}</button>}</section>)}</div>
 {result&&<div role="status" className="notice section-gap">{result}</div>}
 <section className="panel integration-guide"><h2>Connect your services</h2><p>Your server administrator manages private storage and billing connections. Account verification and password-reset emails use Supabase Auth; this application does not require Gmail SMTP credentials.</p><a className="text-button" href="/resend-verification">Resend account verification</a></section></>;
}
