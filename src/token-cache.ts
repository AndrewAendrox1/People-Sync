// Memory-only: deduplicate concurrent requests and never persist credentials.
export function createTokenCache(load:()=>Promise<string|null>, ttl=30_000) {
  let cached:string|null=null, expires=0, generation=0;
  let pending:Promise<string|null>|null=null;
  return {
    clear(){generation++;cached=null;expires=0;pending=null;},
    get():Promise<string|null>{
      if(cached && Date.now()<expires)return Promise.resolve(cached);
      if(pending)return pending;
      const current=generation;
      const request=load().then(token=>{
        if(current===generation){cached=token;expires=Date.now()+ttl;}
        return current===generation?token:null;
      }).finally(()=>{if(current===generation)pending=null;});
      pending=request;return request;
    },
  };
}
