import 'dotenv/config';
import pg from 'pg';

const tables=[
  ['public','organizations'],['public','shifts'],['public','leave_policies'],
  ['public','memberships'],['public','employees'],['public','attendance'],
  ['public','leave_balances'],['public','requests'],['public','projects'],
  ['public','project_members'],['public','tasks'],['public','onboarding_tasks'],
  ['public','holidays'],['public','announcements'],['public','notifications'],
  ['public','documents'],['public','punches'],['public','leave_transactions'],
  ['public','audit_events'],['public','payment_events'],
  ['private','employee_sensitive'],['private','workspace_invitations'],
] as const;

const sourceUrl=process.env.NEON_DATABASE_URL;
const targetUrl=process.env.DATABASE_URL_UNPOOLED;
if(!sourceUrl||!targetUrl)throw new Error('NEON_DATABASE_URL and DATABASE_URL_UNPOOLED are required');
if(sourceUrl===targetUrl)throw new Error('Source and target database connections must be different');
const source=new pg.Client({connectionString:sourceUrl,connectionTimeoutMillis:15_000});
const target=new pg.Client({connectionString:targetUrl,connectionTimeoutMillis:15_000});
const quote=(name:string)=>`"${name}"`;

try{
  await source.connect();await target.connect();
  await source.query('BEGIN');await source.query('SET TRANSACTION READ ONLY');
  const existing=await target.query('SELECT count(*)::int count FROM public.organizations');
  if(existing.rows[0].count)throw new Error('The Supabase target already contains workspaces; import requires an empty target');
  const sourceUsers=(await source.query('SELECT id::text,email FROM neon_auth."user"')).rows as {id:string;email:string}[];
  const targetUsers=(await target.query('SELECT id::text,email,email_confirmed_at FROM auth.users')).rows as {id:string;email:string;email_confirmed_at:string|null}[];
  const verifiedByEmail=new Map(targetUsers.filter(user=>user.email_confirmed_at).map(user=>[user.email.toLowerCase(),user.id]));
  const missing=sourceUsers.filter(user=>!verifiedByEmail.has(user.email.toLowerCase()));
  if(missing.length)throw new Error(`Create and verify Supabase Auth accounts for every existing user first (${missing.length} missing); passwords are never imported`);
  const identities=new Map(sourceUsers.map(user=>[user.id,verifiedByEmail.get(user.email.toLowerCase())!]));
  const employeeManagers=new Map<string,string|null>();
  const counts=new Map<string,number>();
  await target.query('BEGIN');
  for(const [schema,table] of tables){
    const result=await source.query(`SELECT * FROM ${quote(schema)}.${quote(table)}`);
    const rows=result.rows.map(row=>({...row}));
    for(const row of rows){
      if((table==='memberships'||table==='employees')&&row.user_id){
        const mapped=identities.get(row.user_id);
        if(!mapped)throw new Error(`No verified Supabase account mapping exists for a ${table} identity`);
        row.user_id=mapped;
      }
      if(table==='employees'){
        employeeManagers.set(row.id,row.manager_id||null);
        row.manager_id=null;
      }
      if(!Object.keys(row).length)continue;
      const columns=Object.keys(row);
      await target.query(
        `INSERT INTO ${quote(schema)}.${quote(table)} (${columns.map(quote).join(',')}) VALUES (${columns.map((_,index)=>`$${index+1}`).join(',')})`,
        columns.map(column=>row[column]),
      );
    }
    counts.set(`${schema}.${table}`,rows.length);
  }
  for(const [employeeId,managerId] of employeeManagers)if(managerId){
    await target.query('UPDATE public.employees SET manager_id=$2 WHERE id=$1',[employeeId,managerId]);
  }
  for(const [schema,table] of tables){
    const result=await target.query(`SELECT count(*)::int count FROM ${quote(schema)}.${quote(table)}`);
    if(result.rows[0].count!==counts.get(`${schema}.${table}`))throw new Error(`Count verification failed for ${schema}.${table}`);
  }
  await target.query('COMMIT');await source.query('COMMIT');
  for(const [table,count] of counts)console.log(`${table}: ${count}`);
  console.log('Neon workspace data imported and verified. Auth passwords were not copied.');
}catch(error){
  await target.query('ROLLBACK').catch(()=>{});await source.query('ROLLBACK').catch(()=>{});
  console.error(error instanceof Error?error.message:'Data import failed and was rolled back');
  process.exitCode=1;
}finally{await source.end();await target.end();}
