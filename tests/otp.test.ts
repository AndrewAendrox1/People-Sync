import {expect,it,vi} from 'vitest';
import {normalizeOtp,verifyEmailOnce} from '../src/otp';

it('preserves leading zeroes and strips formatting from pasted codes',()=>{
  expect(normalizeOtp(' 012 345\n')).toBe('012345');
  expect(normalizeOtp('012-345\u200b')).toBe('012345');
});
it('rejects incomplete or non-numeric codes before making a request',()=>{
  for(const value of ['12345','1234567','abc123',undefined])expect(()=>normalizeOtp(value)).toThrow('six-digit');
});
it('leaves the OTP step after successful verification without a session request',async()=>{
  const verify=vi.fn().mockResolvedValue({data:{status:true},error:null});
  const onVerified=vi.fn();
  await verifyEmailOnce(verify,onVerified);
  expect(verify).toHaveBeenCalledTimes(1);
  expect(onVerified).toHaveBeenCalledTimes(1);
});
it('does not mark an invalid OTP as verified',async()=>{
  const onVerified=vi.fn();
  await expect(verifyEmailOnce(async()=>({error:{message:'Invalid OTP'}}),onVerified)).rejects.toThrow('Invalid OTP');
  expect(onVerified).not.toHaveBeenCalled();
});
