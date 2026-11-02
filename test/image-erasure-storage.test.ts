import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {createClient} from '@supabase/supabase-js';
import {describe,expect,it} from 'vitest';
import {SupabaseImageStorage} from '../src/modules/media/infrastructure/supabase-image.storage';
import {OUTFIT_MEDIA} from '../src/modules/media/domain/outfit-media.contract';
import {IMAGE_ERASURE} from '../src/modules/media/domain/image-upload.contract';

const F={host:'127.0.0.1',port:0,key:'image-erasure-wire-fixture',object:'creator/aa0cfde9-6f7c-456d-9104-0f84049460f6/aa0cfde9-6f7c-456d-9104-0f84049460f7.jpg',
  prefix:'/storage/v1/object/',post:'POST',get:'GET',one:1,two:2,json:'application/json',
  status:{ok:200,unavailable:503,missing:404,forbidden:403},photo:'personal photograph fixture',id:'aa0cfde9-6f7c-456d-9104-0f84049460f8'} as const;
interface Call {method:string|undefined;path:string|undefined;bytes:number;upsert:string|string[]|undefined;}
async function withWire(run:(storage:SupabaseImageStorage,state:ReturnType<typeof fixture>)=>Promise<void>){
  const state=fixture(),server=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=Buffer.concat(chunks);
    state.calls.push({method:req.method,path:req.url,bytes:body.length,upsert:req.headers['x-upsert']});
    if(req.headers.apikey!==F.key || req.headers.authorization!=='Bearer '+F.key){res.writeHead(F.status.forbidden).end();return;}
    if(req.method===F.post&&req.url===F.prefix+OUTFIT_MEDIA.bucket+'/'+F.object){
      if(state.writeCommits)state.object=body;
      res.writeHead(state.writeStatus,{'Content-Type':F.json}).end(JSON.stringify({Key:OUTFIT_MEDIA.bucket+'/'+F.object,Id:F.id}));return;
    }
    if(req.method===F.get&&req.url===F.prefix+OUTFIT_MEDIA.bucket+'/'+F.object){
      if(state.readStatus!==F.status.ok){res.writeHead(state.readStatus,{'Content-Type':F.json}).end(JSON.stringify({message:F.photo}));return;}
      res.writeHead(F.status.ok,{'Content-Type':OUTFIT_MEDIA.mime}).end(state.object);return;
    }
    res.writeHead(F.status.forbidden).end();
  });
  await new Promise<void>(resolve=>server.listen(F.port,F.host,resolve));
  const origin='http://'+F.host+':'+(server.address() as AddressInfo).port;
  const storage=new SupabaseImageStorage(OUTFIT_MEDIA,()=>createClient(origin,F.key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}}));
  try{await run(storage,state);}finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}
function fixture(){return {calls:[] as Call[],object:Buffer.from(F.photo),writeCommits:true,writeStatus:F.status.ok as number,readStatus:F.status.ok as number};}
describe('Private image erasure HTTP contract',()=>{
  it('replaces only the selected key with an empty object and verifies its bytes',()=>withWire(async(storage,state)=>{
    await storage.eraseOrVerify(F.object);
    expect(state.calls).toEqual([
      {method:F.post,path:F.prefix+OUTFIT_MEDIA.bucket+'/'+F.object,bytes:IMAGE_ERASURE.bytes,upsert:'true'},
      {method:F.get,path:F.prefix+OUTFIT_MEDIA.bucket+'/'+F.object,bytes:IMAGE_ERASURE.bytes,upsert:undefined},
    ]);
    expect(state.object.byteLength).toBe(IMAGE_ERASURE.bytes);
  }));
  it('recovers a lost replacement acknowledgement from the stored marker',()=>withWire(async(storage,state)=>{
    state.writeStatus=F.status.unavailable;await storage.eraseOrVerify(F.object);
    expect(state.calls.filter(x=>x.method===F.post)).toHaveLength(F.one);expect(state.object.byteLength).toBe(IMAGE_ERASURE.bytes);
  }));
  it('never acknowledges a successful upload response with personal bytes still readable',()=>withWire(async(storage,state)=>{
    state.writeCommits=false;await expect(storage.eraseOrVerify(F.object)).rejects.toMatchObject({status:F.status.unavailable});
    expect(state.object.toString()).toBe(F.photo);
  }));
  it('does not treat a missing object as a durable fence against late uploads',()=>withWire(async(storage,state)=>{
    state.readStatus=F.status.missing;await expect(storage.eraseOrVerify(F.object)).rejects.toMatchObject({status:F.status.unavailable});
  }));
  it('replays the same empty marker without broad deletion or a new key',()=>withWire(async(storage,state)=>{
    await storage.eraseOrVerify(F.object);await storage.eraseOrVerify(F.object);
    expect(state.calls.filter(x=>x.method===F.post)).toHaveLength(F.two);
    expect(state.calls.every(x=>x.path?.endsWith(F.object))).toBe(true);expect(state.object.byteLength).toBe(IMAGE_ERASURE.bytes);
  }));
});
