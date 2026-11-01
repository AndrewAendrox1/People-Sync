import {expect,it,vi} from 'vitest';
import {createTokenCache} from '../src/token-cache';

it('shares concurrent token requests and reuses the result',async()=>{
  const load=vi.fn().mockResolvedValue('token');
  const cache=createTokenCache(load);
  expect(await Promise.all([cache.get(),cache.get(),cache.get()])).toEqual(['token','token','token']);
  await cache.get();expect(load).toHaveBeenCalledTimes(1);
});
it('refreshes expired tokens',async()=>{
  vi.useFakeTimers();
  try{
    const load=vi.fn().mockResolvedValue('token'),cache=createTokenCache(load,30_000);
    await cache.get();vi.advanceTimersByTime(30_001);await cache.get();
    expect(load).toHaveBeenCalledTimes(2);
  }finally{vi.useRealTimers();}
});
it('does not restore an in-flight token after sign out',async()=>{
  let resolve!:(token:string)=>void;
  const load=vi.fn().mockImplementationOnce(()=>new Promise<string>(r=>{resolve=r;})).mockResolvedValue('new-token');
  const cache=createTokenCache(load),pending=cache.get();cache.clear();resolve('old-token');
  expect(await pending).toBeNull();expect(await cache.get()).toBe('new-token');
});
it('retries failures without caching errors',async()=>{
  const load=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('token');
  const cache=createTokenCache(load);await expect(cache.get()).rejects.toThrow('offline');
  expect(await cache.get()).toBe('token');
});
