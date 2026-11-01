// Read-only route smoke check; never mounted by the application server.
import 'dotenv/config';
import express from 'express';
import request from 'supertest';
import {databasePool,closeDatabase} from '../server/database';
import {workspaceRoutes} from '../server/workspace';
const pool=databasePool();
try {
 const identity=(await pool.query(`SELECT u.id::text,u.email FROM auth.users u JOIN memberships m ON m.user_id=u.id WHERE m.active AND m.role='owner' AND u.email_confirmed_at IS NOT NULL ORDER BY m.created_at LIMIT 1`)).rows[0];
 if(!identity)throw new Error('No verified workspace owner exists');
 const app=express();app.use((req:any,_res,next)=>{req.identity=identity;next();});app.use(workspaceRoutes);app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status||500).json({code:error.code||error.name}));
 for(const path of ['/dashboard','/employees','/shifts','/attendance','/attendance/today','/reports','/requests','/leaves/policies','/leaves/balances','/people-start','/projects','/employees/me','/settings','/holidays','/users','/audit-logs','/notifications','/documents','/billing','/integrations']){
  const response=await request(app).get(path);console.log(path,response.status);if(response.status!==200){console.log('Diagnostic:',response.body.code);process.exitCode=1;}
 }
}finally{await closeDatabase();}
