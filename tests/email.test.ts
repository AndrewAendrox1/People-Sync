import {afterEach,describe,it,expect,vi} from 'vitest';
const mail=vi.hoisted(()=>({sendMail:vi.fn()}));
vi.mock('nodemailer',()=>({default:{createTransport:()=>mail}}));
import {requireEmail,sendMail} from '../server/services/email';
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();});
function configure(){vi.stubEnv('SMTP_HOST','smtp.gmail.com');vi.stubEnv('SMTP_USER','sender@example.com');vi.stubEnv('SMTP_PASS','test-only');vi.stubEnv('EMAIL_FROM','sender@example.com');}
describe('Email delivery feedback',()=>{
 it('rejects incomplete Gmail credentials before sending',()=>{configure();vi.stubEnv('SMTP_PASS','');expect(requireEmail).toThrow('not configured');expect(mail.sendMail).not.toHaveBeenCalled();});
 it('does not claim success when the provider rejects delivery',async()=>{configure();mail.sendMail.mockRejectedValue(new Error('authentication failed'));await expect(sendMail('recipient@example.com','Verify','test')).rejects.toThrow('could not accept');});
 it('requires an accepted recipient',async()=>{configure();mail.sendMail.mockResolvedValue({accepted:[]});await expect(sendMail('recipient@example.com','Verify','test')).rejects.toThrow('could not accept');});
 it('completes when the provider accepts the message',async()=>{configure();mail.sendMail.mockResolvedValue({accepted:['recipient@example.com']});await expect(sendMail('recipient@example.com','Verify','test')).resolves.toBeUndefined();});
});
