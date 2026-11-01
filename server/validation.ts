import {z} from 'zod';
export const id=z.string().regex(/^[a-f\d]{24}$/i,'Invalid identifier');
export const email=z.string().email().transform(x=>x.toLowerCase().trim());
export const password=z.string().min(12,'Use at least 12 characters').max(128,'Use no more than 128 characters').regex(/[a-z]/,'Include a lowercase letter').regex(/[A-Z]/,'Include an uppercase letter').regex(/\d/,'Include a number');
export const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>!Number.isNaN(Date.parse(v)),'Invalid date');
export const time=z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const employeeSchema=z.object({name:z.string().min(2).max(100),email,phone:z.string().max(30).optional(),department:z.string().min(1).max(80),designation:z.string().max(100).optional(),joiningDate:date,employmentType:z.enum(['Full time','Part time','Contract']).default('Full time'),location:z.string().max(100).optional(),shift:id.optional(),manager:id.optional(),status:z.enum(['Active','Inactive','Exited']).default('Active')});
export const shiftSchema=z.object({name:z.string().min(2),code:z.string().min(2).transform(x=>x.toUpperCase()),start:time,end:time,secondHalf:time.optional(),breakMinutes:z.number().min(0).max(240),graceMinutes:z.number().min(0).max(120),halfMinutes:z.number().min(1).max(720),fullMinutes:z.number().min(1).max(1440),workdays:z.array(z.number().int().min(1).max(7)).min(1),active:z.boolean().default(true)}).refine(x=>x.start!==x.end&&x.fullMinutes>=x.halfMinutes,'Invalid shift duration');

