import {useId,useState} from 'react';
import {ArrowRight} from 'lucide-react';
import {ApiError} from '../api';

export type Field={name:string;label:string;type?:string;options?:any[];required?:boolean;default?:any};
export function Form({fields,initial={},onSubmit,submit='Save changes'}:{fields:Field[];initial?:Record<string,any>;onSubmit:(v:Record<string,any>)=>Promise<any>;submit?:string}){
  const id=useId();
  const [error,setError]=useState(''),[errors,setErrors]=useState<Record<string,string>>({}),[busy,setBusy]=useState(false);
  return <form className="form" aria-busy={busy} onSubmit={async e=>{
    e.preventDefault();if(busy)return;
    const form=e.currentTarget;setError('');setErrors({});setBusy(true);
    const data=new FormData(form),values:Record<string,any>={};
    for(const field of fields){const value=data.get(field.name);if(field.type==='checkbox')values[field.name]=value==='on';else if(value!==null&&value!=='')values[field.name]=field.type==='number'?Number(value):value;else if(Object.prototype.hasOwnProperty.call(initial,field.name))values[field.name]='';}
    try{await onSubmit(values);}catch(err){
      setError(err instanceof Error?err.message:'Unable to save. Please try again.');
      if(err instanceof ApiError){setErrors(err.fields);const first=fields.find(f=>err.fields[f.name]);if(first)(form.elements.namedItem(first.name) as HTMLElement)?.focus();}
    }finally{setBusy(false);}
  }}>
    <div className="form-grid">{fields.map(f=>{
      const props={id:`${id}-${f.name}`,name:f.name,required:f.required!==false,'aria-invalid':!!errors[f.name],'aria-describedby':errors[f.name]?`${id}-${f.name}-error`:undefined,defaultValue:initial[f.name]??f.default??''};
      return <div className={`form-field ${f.type==='textarea'?'full':''}`} key={f.name}>
        <label htmlFor={props.id}>{f.label}{f.required===false&&<span className="field-optional">Optional</span>}</label>
        {f.type==='select'?<select {...props}><option value="">Select {f.label.toLowerCase()}</option>{f.options?.map(o=><option key={o.value??o} value={o.value??o}>{o.label??o}</option>)}</select>:f.type==='textarea'?<textarea {...props}/>:f.type==='checkbox'?<input {...props} type="checkbox" defaultValue={undefined} defaultChecked={Boolean(initial[f.name]??f.default)}/>:<input {...props} type={f.type||'text'} min={f.type==='number'?0:undefined}/>}
        {errors[f.name]&&<small className="field-error" id={`${id}-${f.name}-error`}>{errors[f.name]}</small>}
      </div>;
    })}</div>
    {error&&<div role="alert" className="error">{error}</div>}
    <footer><button className="primary" disabled={busy}>{busy?'Please wait…':submit}<ArrowRight size={16}/></button></footer>
  </form>;
}
