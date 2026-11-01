import 'dotenv/config';
import {spawn} from 'node:child_process';
if(!process.env.DATABASE_URL||!process.env.SUPABASE_URL)throw new Error('Configure Supabase database and Auth before starting People Sync.');
const child=spawn(process.execPath,['node_modules/concurrently/dist/bin/concurrently.js','-k','tsx watch server/index.ts','vite --host 127.0.0.1'],{stdio:'inherit',windowsHide:true});
child.on('exit',code=>process.exit(code||0));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill());
