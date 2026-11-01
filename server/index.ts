import {config} from './config';
import {supabaseApp} from './supabase-app';
import {closeDatabase,databasePool} from './database';
await Promise.all([0,1,2].map(()=>databasePool().query('SELECT 1')));
const server=supabaseApp.listen(config.port,'127.0.0.1',()=>console.log(`People Sync API (Supabase): http://localhost:${config.port}`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(async()=>{await closeDatabase();process.exit(0);}));
