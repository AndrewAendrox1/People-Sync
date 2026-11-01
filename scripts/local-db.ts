import {MongoMemoryReplSet} from 'mongodb-memory-server';
import {mkdirSync} from 'node:fs';
import path from 'node:path';
const db=path.resolve('.data/mongo');mkdirSync(db,{recursive:true});
const repl=await MongoMemoryReplSet.create({replSet:{name:'rs0',count:1,storageEngine:'wiredTiger'},instanceOpts:[{port:27028,dbPath:db}]});
console.log(`Development MongoDB: ${repl.getUri('people-sync')}`);
console.log('Database files are persisted in .data/mongo. Keep this process running.');
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await repl.stop({doCleanup:false,force:false});process.exit(0);});

