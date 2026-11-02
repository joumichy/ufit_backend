import {afterEach,describe,expect,it} from 'vitest';
import {generateKeyPairSync,verify} from 'node:crypto';
import {once} from 'node:events';
import {connect,constants,createServer,type IncomingHttpHeaders,type ServerHttp2Session,type ServerHttp2Stream} from 'node:http2';
import {ApnsPushTransport,type ApnsConfiguration} from '../src/modules/notifications/infrastructure/apns-push.transport';
import {PUSH_DELIVERY as PUSH,type PushDelivery} from '../src/modules/notifications/domain/push-delivery';

const TEST={
  keyType:'ec',curve:'prime256v1',otherCurve:'secp384r1',privateType:'pkcs8',pem:'pem',signature:'sha256',signatureEncoding:'ieee-p1363',base64:'base64url',
  keyId:'KEY1234567',teamId:'TEAM123456',invalidKey:'not-an-apple-key',numericIdentifier:1_234_567_890,publicText:'not a private key',
  deliveryId:'116ae161-1bef-4ff6-9396-0ba40a20e77e',otherId:'116ae161-1bef-4ff6-9396-0ba40a20e77f',
  notificationId:'525ec6d5-a889-4adf-a07e-434cf4209a1c',token:'00ab19ff01',shortToken:'00',oddToken:'abc',upperToken:'ABCD',
  unknownField:'unexpected',zero:0,one:1,two:2,three:3,secondMs:1_000,lifeMs:2*60*60*1_000,shortTimeoutMs:100,
  clockToleranceSeconds:2,beforeRefreshMs:19*60*1_000,refreshMs:45*60*1_000,
  localhost:'127.0.0.1',ephemeralPort:0,http:'http://',portSeparator:':',separator:'.',empty:'',
  events:{listening:'listening',stream:'stream',data:'data',end:'end',error:'error',session:'session',close:'close'},
  expected:{method:'POST',scheme:'https',developmentOrigin:'https://api.sandbox.push.apple.com',productionOrigin:'https://api.push.apple.com',
    authority:'api.sandbox.push.apple.com',path:'/3/device/',topic:'com.stellark.ufit',type:'alert',priority:'10',content:'application/json',
    algorithm:'ES256',title:'Ufit',body:'Vous avez une mise à jour.',sound:'default',bearer:'bearer '},
  headers:{method:':method',path:':path',scheme:':scheme',authority:':authority',status:':status',id:'apns-id',authorization:'authorization',
    topic:'apns-topic',type:'apns-push-type',priority:'apns-priority',content:'content-type',expiration:'apns-expiration',collapse:'apns-collapse-id'},
  status:{accepted:200,bad:400,credentials:403,unregistered:410,rate:429,internal:500,unavailable:503},
  invalidatedAt:1_762_063_200_123,largeBytes:8_193,largeCharacter:'x',badJSON:'not-json',nonempty:'{}',
  reason:{badDevice:'BadDeviceToken',wrongTopic:'DeviceTokenNotForTopic',unregistered:'Unregistered',expired:'ExpiredToken',forbidden:'Forbidden',
    badPath:'BadPath',rate:'TooManyRequests',tokenRate:'TooManyProviderTokenUpdates',internal:'InternalServerError',unavailable:'ServiceUnavailable',shutdown:'Shutdown'},
  retry:{rate:60_000,token:1_200_000,server:900_000},
} as const;
const keys=generateKeyPairSync(TEST.keyType,{namedCurve:TEST.curve});
const privateKey=keys.privateKey.export({type:TEST.privateType,format:TEST.pem}).toString();
function configuration():ApnsConfiguration{return {environment:PUSH.environment.development,keyId:TEST.keyId,teamId:TEST.teamId,privateKey};}
function delivery():PushDelivery{return {deliveryId:TEST.deliveryId,notificationId:TEST.notificationId,environment:PUSH.environment.development,
  deviceToken:TEST.token,expiresAt:new Date(Date.now()+TEST.lifeMs)};}
interface Captured {headers:IncomingHttpHeaders;body:Buffer;}
type Reply=(stream:ServerHttp2Stream,request:Captured)=>void;
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(TEST.zero))await close();});
async function harness(reply:Reply=(stream,request)=>{stream.respond({[TEST.headers.status]:TEST.status.accepted,[TEST.headers.id]:request.headers[TEST.headers.id]});stream.end();},streamLimit:number=TEST.two){
  const server=createServer({settings:{maxConcurrentStreams:streamLimit}}),sessions=new Set<ServerHttp2Session>(),requests:Captured[]=[],origins:string[]=[];
  server.on(TEST.events.session,session=>sessions.add(session));
  server.on(TEST.events.stream,(stream,headers)=>{
    const chunks:Buffer[]=[];stream.on(TEST.events.error,()=>undefined);
    stream.on(TEST.events.data,(data:Buffer)=>chunks.push(data));
    stream.on(TEST.events.end,()=>{if(stream.closed||stream.destroyed)return;const captured={headers,body:Buffer.concat(chunks)};requests.push(captured);reply(stream,captured);});
  });
  server.listen(TEST.ephemeralPort,TEST.localhost);await once(server,TEST.events.listening);
  const address=server.address();if(!address||typeof address===typeof TEST.empty)throw new Error(TEST.localhost);
  const origin=TEST.http+TEST.localhost+TEST.portSeparator+(address as {port:number}).port;
  const transports:ApnsPushTransport[]=[];
  function transport(config=configuration()){
    const value=new ApnsPushTransport(config,remote=>{origins.push(remote);return connect(origin);});transports.push(value);return value;
  }
  cleanup.push(async()=>{for(const client of transports)client.close();for(const session of sessions)session.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  return {transport,requests,origins,sessions,origin,server};
}
describe('APNs real HTTP/2 wire contract, with local-only provider',()=>{
  it('sends the canonical private opening payload and a verifiable ES256 bearer to the fixed sandbox topic',async()=>{
    const h=await harness(),transport=h.transport(),input=delivery(),result=await transport.send(input);
    expect(result).toEqual({outcome:PUSH.outcome.accepted,providerMessageId:TEST.deliveryId});expect(h.origins).toEqual([TEST.expected.developmentOrigin]);
    expect(h.requests).toHaveLength(TEST.one);const {headers,body}=h.requests[TEST.zero],header=TEST.headers;
    expect(headers).toMatchObject({[header.method]:TEST.expected.method,[header.scheme]:TEST.expected.scheme,[header.authority]:TEST.expected.authority,
      [header.path]:TEST.expected.path+TEST.token,[header.id]:TEST.deliveryId,[header.topic]:TEST.expected.topic,[header.type]:TEST.expected.type,
      [header.priority]:TEST.expected.priority,[header.content]:TEST.expected.content,[header.collapse]:TEST.notificationId,
      [header.expiration]:String(Math.floor(input.expiresAt.getTime()/TEST.secondMs))});
    expect(JSON.parse(body.toString())).toEqual({aps:{alert:{title:TEST.expected.title,body:TEST.expected.body},sound:TEST.expected.sound},notificationId:TEST.notificationId});
    const bearer=String(headers[header.authorization]);expect(bearer.startsWith(TEST.expected.bearer)).toBe(true);
    const token=bearer.slice(TEST.expected.bearer.length),parts=token.split(TEST.separator);expect(parts).toHaveLength(TEST.three);
    expect(JSON.parse(Buffer.from(parts[TEST.zero],TEST.base64).toString())).toEqual({alg:TEST.expected.algorithm,kid:TEST.keyId});
    const payload=JSON.parse(Buffer.from(parts[TEST.one],TEST.base64).toString());expect(payload.iss).toBe(TEST.teamId);
    expect(Math.abs(payload.iat-Math.floor(Date.now()/TEST.secondMs))).toBeLessThanOrEqual(TEST.clockToleranceSeconds);
    expect(verify(TEST.signature,Buffer.from(parts.slice(TEST.zero,TEST.two).join(TEST.separator)),{key:keys.publicKey,dsaEncoding:TEST.signatureEncoding},Buffer.from(parts[TEST.two],TEST.base64))).toBe(true);
  });
  it('reuses one HTTP/2 connection and the same bearer for concurrent sends',async()=>{
    const h=await harness(undefined,TEST.one),transport=h.transport();const results=await Promise.all([transport.send(delivery()),transport.send({...delivery(),deliveryId:TEST.otherId})]);
    expect(results.every(value=>value.outcome===PUSH.outcome.accepted)).toBe(true);expect(h.origins).toHaveLength(TEST.one);expect(h.requests).toHaveLength(TEST.two);
    expect(h.requests[TEST.zero].headers[TEST.headers.authorization]).toBe(h.requests[TEST.one].headers[TEST.headers.authorization]);
  });
  it('does not assume a fixed number of token bytes',async()=>{
    const h=await harness(),result=await h.transport().send({...delivery(),deviceToken:TEST.shortToken});expect(result.outcome).toBe(PUSH.outcome.accepted);
    expect(h.requests[TEST.zero].headers[TEST.headers.path]).toBe(TEST.expected.path+TEST.shortToken);
  });
  it('opens a new connection after GOAWAY without replaying the already accepted message',async()=>{
    const h=await harness(),transport=h.transport();expect((await transport.send(delivery())).outcome).toBe(PUSH.outcome.accepted);
    const session=[...h.sessions][TEST.zero],closed=once(session,TEST.events.close);session.close();await closed;
    expect((await transport.send({...delivery(),deliveryId:TEST.otherId})).outcome).toBe(PUSH.outcome.accepted);
    expect(h.origins).toHaveLength(TEST.two);expect(h.requests.map(r=>r.headers[TEST.headers.id])).toEqual([TEST.deliveryId,TEST.otherId]);
  });
  it('does not rebind the transport when the caller mutates its configuration',async()=>{
    const h=await harness(),config=configuration(),transport=h.transport(config);config.environment=PUSH.environment.production;
    expect((await transport.send(delivery())).outcome).toBe(PUSH.outcome.accepted);expect(h.origins).toEqual([TEST.expected.developmentOrigin]);
    expect((await transport.send({...delivery(),environment:PUSH.environment.production})).outcome).toBe(PUSH.outcome.rejected);expect(h.requests).toHaveLength(TEST.one);
  });
  it('uses the fixed production origin only for a production-bound transport',async()=>{
    const h=await harness(),config={...configuration(),environment:PUSH.environment.production};
    expect((await h.transport(config).send({...delivery(),environment:PUSH.environment.production})).outcome).toBe(PUSH.outcome.accepted);
    expect(h.origins).toEqual([TEST.expected.productionOrigin]);
  });
  it.each([TEST.oddToken,TEST.upperToken,TEST.empty])('rejects a malformed canonical device token before any connection: %s',async deviceToken=>{
    const h=await harness(),result=await h.transport().send({...delivery(),deviceToken});expect(result).toEqual({outcome:PUSH.outcome.rejected,reason:PUSH.failure.input});expect(h.origins).toHaveLength(TEST.zero);
  });
  it('rejects additional payload data instead of forwarding private business fields',async()=>{
    const h=await harness(),result=await h.transport().send({...delivery(),[TEST.unknownField]:TEST.notificationId} as PushDelivery);
    expect(result).toEqual({outcome:PUSH.outcome.rejected,reason:PUSH.failure.input});expect(h.origins).toHaveLength(TEST.zero);
  });
  it('does not open a connection for an expired delivery or an environment mismatch',async()=>{
    const h=await harness(),transport=h.transport();
    expect((await transport.send({...delivery(),expiresAt:new Date(TEST.zero)})).outcome).toBe(PUSH.outcome.expired);
    expect((await transport.send({...delivery(),environment:PUSH.environment.production})).outcome).toBe(PUSH.outcome.rejected);expect(h.origins).toHaveLength(TEST.zero);
  });
  it('refreshes the bearer after 45 minutes and retains the signing identity',async()=>{
    const h=await harness(),transport=h.transport();await transport.send(delivery());
    await transport.send(delivery(),new Date(Date.now()+TEST.beforeRefreshMs));
    await transport.send(delivery(),new Date(Date.now()+TEST.refreshMs));
    const tokens=h.requests.map(r=>String(r.headers[TEST.headers.authorization]));expect(tokens).toHaveLength(TEST.three);
    expect(tokens[TEST.zero]).toBe(tokens[TEST.one]);expect(tokens[TEST.zero]).not.toBe(tokens[TEST.two]);expect(h.origins).toHaveLength(TEST.one);
  });
  it('rejects malformed identifiers and a non-P-256 key without a connection',()=>{
    expect(()=>new ApnsPushTransport({...configuration(),keyId:TEST.invalidKey})).toThrow(PUSH.failure.configuration);
    expect(()=>new ApnsPushTransport({...configuration(),keyId:TEST.numericIdentifier as unknown as string})).toThrow(PUSH.failure.configuration);
    expect(()=>new ApnsPushTransport({...configuration(),privateKey:TEST.publicText})).toThrow(PUSH.failure.configuration);
    const other=generateKeyPairSync(TEST.keyType,{namedCurve:TEST.otherCurve});
    expect(()=>new ApnsPushTransport({...configuration(),privateKey:other.privateKey.export({type:TEST.privateType,format:TEST.pem}).toString()})).toThrow(PUSH.failure.configuration);
  });
  const responses=[
    {status:TEST.status.bad,reason:TEST.reason.badDevice,expected:{outcome:PUSH.outcome.invalidDevice,reason:PUSH.failure.device,invalidatedAt:null}},
    {status:TEST.status.bad,reason:TEST.reason.wrongTopic,expected:{outcome:PUSH.outcome.invalidDevice,reason:PUSH.failure.device,invalidatedAt:null}},
    {status:TEST.status.bad,reason:TEST.reason.badPath,expected:{outcome:PUSH.outcome.rejected,reason:PUSH.failure.request}},
    {status:TEST.status.credentials,reason:TEST.reason.forbidden,expected:{outcome:PUSH.outcome.rejected,reason:PUSH.failure.credentials}},
    {status:TEST.status.rate,reason:TEST.reason.rate,expected:{outcome:PUSH.outcome.retry,reason:PUSH.failure.rate,retryAfterMs:TEST.retry.rate}},
    {status:TEST.status.rate,reason:TEST.reason.tokenRate,expected:{outcome:PUSH.outcome.retry,reason:PUSH.failure.tokenRate,retryAfterMs:TEST.retry.token}},
    {status:TEST.status.internal,reason:TEST.reason.internal,expected:{outcome:PUSH.outcome.retry,reason:PUSH.failure.unavailable,retryAfterMs:TEST.retry.server}},
    {status:TEST.status.unavailable,reason:TEST.reason.unavailable,expected:{outcome:PUSH.outcome.retry,reason:PUSH.failure.unavailable,retryAfterMs:TEST.retry.server}},
    {status:TEST.status.unavailable,reason:TEST.reason.shutdown,expected:{outcome:PUSH.outcome.retry,reason:PUSH.failure.unavailable,retryAfterMs:TEST.retry.server}},
  ];
  it.each(responses)('classifies a real HTTP/2 rejection $status/$reason without another POST',async value=>{
    const h=await harness((stream,request)=>{stream.respond({[TEST.headers.status]:value.status,[TEST.headers.id]:request.headers[TEST.headers.id]});stream.end(JSON.stringify({reason:value.reason}));});
    expect(await h.transport().send(delivery())).toEqual(value.expected);expect(h.requests).toHaveLength(TEST.one);
  });
  it.each([TEST.reason.unregistered,TEST.reason.expired])('preserves the exact APNs invalidation time in milliseconds: %s',async reason=>{
    const h=await harness((stream,request)=>{stream.respond({[TEST.headers.status]:TEST.status.unregistered,[TEST.headers.id]:request.headers[TEST.headers.id]});stream.end(JSON.stringify({reason,timestamp:TEST.invalidatedAt}));});
    expect(await h.transport().send(delivery())).toEqual({outcome:PUSH.outcome.invalidDevice,reason:PUSH.failure.device,invalidatedAt:new Date(TEST.invalidatedAt)});
  });
  it.each([
    {status:TEST.status.accepted,body:TEST.nonempty,id:TEST.deliveryId},
    {status:TEST.status.accepted,body:TEST.empty,id:TEST.otherId},
    {status:TEST.status.accepted,body:TEST.empty,id:TEST.empty},
    {status:TEST.status.unregistered,body:JSON.stringify({reason:TEST.reason.unregistered}),id:TEST.deliveryId},
    {status:TEST.status.bad,body:JSON.stringify({reason:TEST.reason.badDevice,timestamp:TEST.invalidatedAt}),id:TEST.deliveryId},
    {status:TEST.status.unavailable,body:TEST.badJSON,id:TEST.deliveryId},
  ])('does not infer acceptance or invalidate a device from a malformed response: %j',async value=>{
    const h=await harness(stream=>{stream.respond({[TEST.headers.status]:value.status,[TEST.headers.id]:value.id});stream.end(value.body);});
    expect(await h.transport().send(delivery())).toEqual({outcome:PUSH.outcome.unknown,reason:PUSH.failure.response});expect(h.requests).toHaveLength(TEST.one);
  });
  it('treats a response lost after receiving the payload as unknown and makes no hidden retry',async()=>{
    const h=await harness(stream=>stream.close());expect(await h.transport().send(delivery())).toEqual({outcome:PUSH.outcome.unknown,reason:PUSH.failure.transport});expect(h.requests).toHaveLength(TEST.one);
  });
  it('bounds the response body and does not retry a malformed large response',async()=>{
    const h=await harness((stream,request)=>{stream.respond({[TEST.headers.status]:TEST.status.bad,[TEST.headers.id]:request.headers[TEST.headers.id]});stream.end(TEST.largeCharacter.repeat(TEST.largeBytes));});
    expect(await h.transport().send(delivery())).toEqual({outcome:PUSH.outcome.unknown,reason:PUSH.failure.response});expect(h.requests).toHaveLength(TEST.one);
  });
  it('times out a submitted request without silently replaying it',async()=>{
    const h=await harness(()=>undefined),transport=h.transport({...configuration(),timeoutMs:TEST.shortTimeoutMs});
    expect(await transport.send(delivery())).toEqual({outcome:PUSH.outcome.unknown,reason:PUSH.failure.transport});expect(h.requests).toHaveLength(TEST.one);
  });
  it('does not create a stream while the peer advertises a zero-stream window',async()=>{
    const h=await harness(undefined,TEST.zero),transport=h.transport({...configuration(),timeoutMs:TEST.shortTimeoutMs});
    expect(await transport.send(delivery())).toEqual({outcome:PUSH.outcome.retry,reason:PUSH.failure.unavailable,retryAfterMs:TEST.retry.rate});
    expect(h.requests).toHaveLength(TEST.zero);expect(h.origins).toHaveLength(TEST.one);
  });
  it('recognizes an explicit REFUSED_STREAM as not processed, without a second stream',async()=>{
    const h=await harness();let streams=TEST.zero as number;
    h.server.prependOnceListener(TEST.events.stream,(stream:ServerHttp2Stream)=>{streams++;stream.close(constants.NGHTTP2_REFUSED_STREAM);});
    expect(await h.transport().send(delivery())).toEqual({outcome:PUSH.outcome.retry,reason:PUSH.failure.unavailable,retryAfterMs:TEST.retry.rate});
    expect(streams).toBe(TEST.one);expect(h.requests).toHaveLength(TEST.zero);
  });
  it('recognizes GOAWAY only for a stream above the last possibly processed ID',async()=>{
    const h=await harness(),transport=h.transport();let streams=TEST.zero as number;
    expect((await transport.send(delivery())).outcome).toBe(PUSH.outcome.accepted);
    h.server.prependOnceListener(TEST.events.stream,(stream:ServerHttp2Stream)=>{
      streams++;stream.session!.goaway(constants.NGHTTP2_NO_ERROR,TEST.one);stream.close(constants.NGHTTP2_CANCEL);
    });
    expect(await transport.send({...delivery(),deliveryId:TEST.otherId})).toEqual({outcome:PUSH.outcome.retry,reason:PUSH.failure.unavailable,retryAfterMs:TEST.retry.rate});
    expect(streams).toBe(TEST.one);expect(h.requests).toHaveLength(TEST.one);
  });
  it('keeps a result unknown when GOAWAY includes the current stream as possibly processed',async()=>{
    const h=await harness(stream=>{stream.session!.goaway(constants.NGHTTP2_NO_ERROR,stream.id);stream.close(constants.NGHTTP2_CANCEL);});
    expect(await h.transport().send(delivery())).toEqual({outcome:PUSH.outcome.unknown,reason:PUSH.failure.transport});expect(h.requests).toHaveLength(TEST.one);
  });
  it('allows a later retry when connection establishment fails before any request',async()=>{
    const h=await harness();await new Promise<void>(resolve=>h.server.close(()=>resolve()));
    expect(await h.transport().send(delivery())).toEqual({outcome:PUSH.outcome.retry,reason:PUSH.failure.unavailable,retryAfterMs:TEST.retry.rate});expect(h.requests).toHaveLength(TEST.zero);
  });
  it('closes a pending connection and never submits a request after shutdown',async()=>{
    const h=await harness(),transport=h.transport(),pending=transport.send(delivery());transport.close();await pending;
    expect(await transport.send(delivery())).toEqual({outcome:PUSH.outcome.rejected,reason:PUSH.failure.closed});expect(h.requests).toHaveLength(TEST.zero);
  });
});
