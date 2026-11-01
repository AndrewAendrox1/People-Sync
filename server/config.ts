import 'dotenv/config';
export const config = {production:process.env.NODE_ENV==='production',port:Number(process.env.PORT||4000),url:process.env.APP_URL||'http://localhost:5173',mongo:process.env.MONGODB_URI||'mongodb://127.0.0.1:27028/people-sync?replicaSet=rs0'};
if(config.production && !process.env.APP_URL?.startsWith('https://')) throw new Error('Production APP_URL must use HTTPS');


