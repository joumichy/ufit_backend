import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import {createClient} from '@supabase/supabase-js';
import {describe,expect,it} from 'vitest';
import {SupabaseAccountDeletion} from '../src/modules/identity/infrastructure/auth/supabase-account-deletion';
import {ACCOUNT_DELETION as D,AccountDeletionAuthorityFailure} from '../src/modules/identity/domain/account-deletion.contract';

const F={host:'127.0.0.1',port:0,key:'account-deletion-wire-fixture',userId:'aa0cfde9-6f7c-456d-9104-0f84049460f6',
  foreign:'aa0cfde9-6f7c-456d-9104-0f84049460f7',identity:'aa0cfde9-6f7c-456d-9104-0f84049460f8',date:'2026-11-02T00:00:00.000Z',
  path:'/auth/v1/admin/users/',get:'GET',delete:'DELETE',json:'application/json',encoding:'utf8',bearer:'Bearer ',apiVersion:'2024-01-01',versionHeader:'X-Supabase-Api-Version',
  zero:0,one:1,three:3,invalid:'invalid',provider:'email',missing:'user_not_found',otherMissing:'not_found',message:'Wire qualification',
  status:{ok:200,missing:404,forbidden:403,unavailable:503,internal:500}} as const;
interface WireCall {method:string|undefined;path:string|undefined;body:string;}
async function withWire(run:(subject:SupabaseAccountDeletion,state:ReturnType<typeof fixture>)=>Promise<void>){
  const state=fixture();
  const server=createServer(async(req:IncomingMessage,res:ServerResponse)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    const body=Buffer.concat(chunks).toString(F.encoding);state.calls.push({method:req.method,path:req.url,body});
    if(req.url!==F.path+F.userId || req.headers.authorization!==F.bearer+F.key || req.headers.apikey!==F.key){res.writeHead(F.status.forbidden).end();return;}
    res.setHeader('Content-Type',F.json);
    res.setHeader(F.versionHeader,F.apiVersion);
    if(req.method===F.delete){
      if(JSON.stringify(JSON.parse(body))!==JSON.stringify({should_soft_delete:false})){res.writeHead(F.status.internal).end();return;}
      if(state.deleteCommits)state.exists=false;
      state.didDelete=true;res.writeHead(state.deleteStatus).end(JSON.stringify(state.user));return;
    }
    if(req.method!==F.get){res.writeHead(F.status.forbidden).end();return;}
    const status=state.didDelete?state.afterGetStatus:state.beforeGetStatus;
    if(status!==F.status.ok){res.writeHead(status).end(JSON.stringify({code:state.readError,msg:F.message}));return;}
    if(!state.exists){res.writeHead(F.status.missing).end(JSON.stringify({code:F.missing,msg:F.message}));return;}
    res.writeHead(F.status.ok).end(JSON.stringify(state.user));
  });
  await new Promise<void>(resolve=>server.listen(F.port,F.host,resolve));
  const origin='http://'+F.host+':'+(server.address() as AddressInfo).port;
  const subject=new SupabaseAccountDeletion(()=>createClient(origin,F.key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}}));
  try{await run(subject,state);}finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}
function fixture(){return {calls:[] as WireCall[],exists:true,didDelete:false,deleteCommits:true,
  deleteStatus:F.status.ok as number,beforeGetStatus:F.status.ok as number,afterGetStatus:F.status.ok as number,readError:F.missing as string,
  user:{id:F.userId,aud:'authenticated',created_at:F.date,app_metadata:{},user_metadata:{},
    identities:[{id:F.identity,user_id:F.userId,provider:F.provider}]} as Record<string,unknown>};}
describe('Supabase account deletion through the installed SDK and HTTP',()=>{
  it('checks authority and identities before the local account is closed',()=>withWire(async(subject,state)=>{
    await subject.prepare(F.userId);expect(state.calls.map(x=>x.method)).toEqual([F.get]);expect(state.exists).toBe(true);
  }));
  it('does not close an Apple account before its revocation authority is available',()=>withWire(async(subject,state)=>{
    state.user.identities=[{id:F.identity,user_id:F.userId,provider:D.auth.appleProvider}];
    await expect(subject.prepare(F.userId)).rejects.toMatchObject({reason:D.retry.apple});expect(state.calls.map(x=>x.method)).toEqual([F.get]);
  }));
  it('uses the exact hard-delete body and confirms absence, including replay',()=>withWire(async(subject,state)=>{
    await subject.erase(F.userId.toUpperCase());
    expect(state.calls.map(x=>x.method)).toEqual([F.get,F.delete,F.get]);
    expect(JSON.parse(state.calls[F.one].body)).toEqual({should_soft_delete:false});
    await subject.erase(F.userId);expect(state.calls.filter(x=>x.method===F.delete)).toHaveLength(F.one);
  }));
  it('recognizes a previously deleted user without issuing a new DELETE',()=>withWire(async(subject,state)=>{
    state.exists=false;await subject.erase(F.userId);expect(state.calls.map(x=>x.method)).toEqual([F.get]);
  }));
  it('recovers a response lost after the provider committed without resending',()=>withWire(async(subject,state)=>{
    state.deleteStatus=F.status.internal;await subject.erase(F.userId);expect(state.calls.map(x=>x.method)).toEqual([F.get,F.delete,F.get]);
  }));
  it('does not accept a successful DELETE response while the user still exists',()=>withWire(async(subject,state)=>{
    state.deleteCommits=false;await expect(subject.erase(F.userId)).rejects.toMatchObject({reason:D.retry.auth});
    expect(state.calls.map(x=>x.method)).toEqual([F.get,F.delete,F.get]);
  }));
  it.each([F.status.forbidden,F.status.unavailable])('does not delete after a failed preflight read (%s)',status=>withWire(async(subject,state)=>{
    state.beforeGetStatus=status;await expect(subject.erase(F.userId)).rejects.toBeInstanceOf(AccountDeletionAuthorityFailure);
    expect(state.calls.map(x=>x.method)).toEqual([F.get]);
  }));
  it('requires the canonical missing-user code, not an arbitrary 404',()=>withWire(async(subject,state)=>{
    state.beforeGetStatus=F.status.missing;state.readError=F.otherMissing;
    await expect(subject.erase(F.userId)).rejects.toMatchObject({reason:D.retry.auth});expect(state.calls).toHaveLength(F.one);
  }));
  it('requires the canonical identity list before assuming no Apple authorization',()=>withWire(async(subject,state)=>{
    delete state.user.identities;await expect(subject.erase(F.userId)).rejects.toMatchObject({reason:D.retry.auth});expect(state.calls).toHaveLength(F.one);
  }));
  it('does not delete an Apple identity without its token-revocation authority',()=>withWire(async(subject,state)=>{
    state.user.identities=[{id:F.identity,user_id:F.userId,provider:D.auth.appleProvider}];
    await expect(subject.erase(F.userId)).rejects.toMatchObject({reason:D.retry.apple});expect(state.calls).toHaveLength(F.one);
  }));
  it('rejects an identity belonging to another subject',()=>withWire(async(subject,state)=>{
    state.user.identities=[{id:F.identity,user_id:F.foreign,provider:F.provider}];
    await expect(subject.erase(F.userId)).rejects.toMatchObject({reason:D.retry.auth});expect(state.calls).toHaveLength(F.one);
  }));
  it('rechecks an uncertain deletion on the next attempt before any new DELETE',()=>withWire(async(subject,state)=>{
    state.afterGetStatus=F.status.unavailable;await expect(subject.erase(F.userId)).rejects.toMatchObject({reason:D.retry.auth});
    state.afterGetStatus=F.status.ok;await subject.erase(F.userId);
    expect(state.calls.filter(x=>x.method===F.delete)).toHaveLength(F.one);
  }));
  it('rejects an invalid subject before constructing a provider client',async()=>{
    let constructed=false;const subject=new SupabaseAccountDeletion(()=>{constructed=true;throw new Error(F.invalid);});
    await expect(subject.erase(F.invalid)).rejects.toBeInstanceOf(AccountDeletionAuthorityFailure);expect(constructed).toBe(false);
  });
});
