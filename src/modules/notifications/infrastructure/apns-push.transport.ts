import {createPrivateKey,sign,type KeyObject} from 'node:crypto';
import {connect,constants,type ClientHttp2Session,type IncomingHttpHeaders} from 'node:http2';
import {z} from 'zod';
import {PUSH_DELIVERY as PUSH,pushDeliverySchema,type PushDelivery,type PushEnvironment,type PushTransportResult} from '../domain/push-delivery';
import {APNS,apnsResponse} from './apns-protocol';

const apnsConfigurationSchema=z.object({environment:pushDeliverySchema.shape.environment,
  keyId:z.string().regex(APNS.jwt.identifier),teamId:z.string().regex(APNS.jwt.identifier),privateKey:z.string().min(APNS.limits.minimum),
  timeoutMs:z.number().int().min(APNS.limits.minimum).max(APNS.limits.maximumTimeoutMs).optional()}).strict();
export type ApnsConfiguration=z.infer<typeof apnsConfigurationSchema>;
type Connector=(origin:string)=>ClientHttp2Session;

export class ApnsPushTransport {
  private readonly key:KeyObject;
  private readonly timeoutMs:number;
  private readonly environment:PushEnvironment;
  private readonly keyId:string;
  private readonly teamId:string;
  private session?:ClientHttp2Session;
  private connecting?:Promise<ClientHttp2Session>;
  private opening?:ClientHttp2Session;
  private readonly lastProcessedStream=new WeakMap<ClientHttp2Session,number>();
  private token?:{value:string;issuedAt:number};
  private stopped=false;
  constructor(configuration:ApnsConfiguration,private readonly connector:Connector=connect) {
    const parsed=apnsConfigurationSchema.safeParse(configuration);
    if(!parsed.success)throw new Error(PUSH.failure.configuration);
    const input=parsed.data;
    this.timeoutMs=input.timeoutMs??APNS.limits.defaultTimeoutMs;
    try {this.key=createPrivateKey(input.privateKey);}catch{throw new Error(PUSH.failure.configuration);}
    if(this.key.asymmetricKeyType!==APNS.jwt.keyType||this.key.asymmetricKeyDetails?.namedCurve!==APNS.jwt.curve)throw new Error(PUSH.failure.configuration);
    this.environment=input.environment;this.keyId=input.keyId;this.teamId=input.teamId;
  }
  async send(raw:PushDelivery,now=new Date()):Promise<PushTransportResult> {
    const parsed=pushDeliverySchema.safeParse(raw);
    if(!parsed.success||!Number.isFinite(now.getTime()))return {outcome:PUSH.outcome.rejected,reason:PUSH.failure.input};
    const delivery=parsed.data;
    if(delivery.environment!==this.environment)return {outcome:PUSH.outcome.rejected,reason:PUSH.failure.configuration};
    if(this.stopped)return {outcome:PUSH.outcome.rejected,reason:PUSH.failure.closed};
    if(delivery.expiresAt.getTime()<=now.getTime())return {outcome:PUSH.outcome.expired,reason:PUSH.failure.expired};
    let connection:ClientHttp2Session;
    try {connection=await this.connection();}
    catch{return {outcome:PUSH.outcome.retry,reason:PUSH.failure.unavailable,retryAfterMs:APNS.limits.rateRetryMs};}
    if(connection.remoteSettings.maxConcurrentStreams===APNS.limits.zero)return {outcome:PUSH.outcome.retry,reason:PUSH.failure.unavailable,retryAfterMs:APNS.limits.rateRetryMs};
    // Connection acquisition can take time; expiry and JWT age are checked again before submission.
    const submittingAt=new Date(Math.max(now.getTime(),Date.now()));
    const expiration=Math.floor(delivery.expiresAt.getTime()/APNS.limits.secondMs);
    if(expiration<=Math.floor(submittingAt.getTime()/APNS.limits.secondMs))return {outcome:PUSH.outcome.expired,reason:PUSH.failure.expired};
    const body=Buffer.from(JSON.stringify({aps:{alert:PUSH.copy,sound:APNS.value.sound},notificationId:delivery.notificationId}));
    if(body.length>APNS.limits.payloadBytes)return {outcome:PUSH.outcome.rejected,reason:PUSH.failure.input};
    const header=APNS.header;
    return new Promise(resolve=>{
      let request:ReturnType<ClientHttp2Session['request']>;
      try {
        request=connection.request({[header.method]:APNS.method,[header.path]:APNS.path+delivery.deviceToken,
          [header.authority]:new URL(APNS.origin[delivery.environment]).host,[header.scheme]:APNS.scheme,
          [header.id]:delivery.deliveryId,[header.topic]:APNS.topic,[header.type]:APNS.value.alert,[header.priority]:APNS.value.priority,
          [header.collapse]:delivery.notificationId,[header.expiration]:String(expiration),
          [header.authorization]:APNS.value.bearer+this.bearer(submittingAt),[header.content]:APNS.value.content});
      }catch{resolve({outcome:PUSH.outcome.retry,reason:PUSH.failure.unavailable,retryAfterMs:APNS.limits.rateRetryMs});return;}
      let settled=false,headers:IncomingHttpHeaders|undefined,size=APNS.limits.zero as number;
      const chunks:Buffer[]=[];
      const unknown={outcome:PUSH.outcome.unknown,reason:PUSH.failure.transport} as const;
      const finish=(result:PushTransportResult)=>{
        if(settled)return;settled=true;clearTimeout(timer);resolve(result);
        if(!request.closed)request.close(constants.NGHTTP2_CANCEL);
      };
      const lost=()=>{
        const lastProcessed=this.lastProcessedStream.get(connection);
        const notProcessed=!headers&&(request.id===undefined||request.rstCode===constants.NGHTTP2_REFUSED_STREAM||
          lastProcessed!==undefined&&request.id>lastProcessed);
        finish(notProcessed?{outcome:PUSH.outcome.retry,reason:PUSH.failure.unavailable,retryAfterMs:APNS.limits.rateRetryMs}:unknown);
      };
      const timer=setTimeout(lost,this.timeoutMs);
      request.on(APNS.event.response,value=>{headers=value;});
      request.on(APNS.event.data,(value:Buffer)=>{size+=value.length;if(size>APNS.limits.responseBytes)finish({outcome:PUSH.outcome.unknown,reason:PUSH.failure.response});else chunks.push(value);});
      request.on(APNS.event.error,lost);request.on(APNS.event.aborted,lost);request.on(APNS.event.close,lost);
      request.on(APNS.event.end,()=>finish(headers?apnsResponse(headers,Buffer.concat(chunks),delivery.deliveryId):unknown));
      try {request.end(body);}catch{lost();}
    });
  }
  private bearer(now:Date):string {
    const instant=now.getTime();
    if(this.token&&instant>=this.token.issuedAt&&instant-this.token.issuedAt<APNS.limits.tokenReuseMs)return this.token.value;
    const header=Buffer.from(JSON.stringify({alg:APNS.jwt.algorithm,kid:this.keyId})).toString(APNS.jwt.encoding);
    const payload=Buffer.from(JSON.stringify({iss:this.teamId,iat:Math.floor(instant/APNS.limits.secondMs)})).toString(APNS.jwt.encoding);
    const content=header+APNS.jwt.separator+payload;
    const signature=sign(APNS.jwt.signing,Buffer.from(content),{key:this.key,dsaEncoding:APNS.jwt.signature}).toString(APNS.jwt.encoding);
    this.token={value:content+APNS.jwt.separator+signature,issuedAt:instant};return this.token.value;
  }
  private connection():Promise<ClientHttp2Session> {
    if(this.stopped)return Promise.reject(new Error(PUSH.failure.closed));
    if(this.session&&!this.session.closed&&!this.session.destroyed)return Promise.resolve(this.session);
    if(this.connecting)return this.connecting;
    const pending=new Promise<ClientHttp2Session>((resolve,reject)=>{
      const session=this.connector(APNS.origin[this.environment]);
      this.opening=session;
      const timer=setTimeout(()=>session.destroy(new Error(PUSH.failure.unavailable)),this.timeoutMs);
      let connected=false,settingsReceived=false;
      const ready=()=>{
        if(!connected||!settingsReceived)return;
        clearTimeout(timer);
        if(this.opening===session)this.opening=undefined;
        if(this.stopped){session.destroy();reject(new Error(PUSH.failure.closed));return;}
        this.session=session;resolve(session);
      };
      session.on(APNS.event.error,error=>{clearTimeout(timer);if(this.session===session)this.session=undefined;if(this.opening===session)this.opening=undefined;reject(error);});
      session.once(APNS.event.connect,()=>{
        connected=true;ready();
      });
      session.once(APNS.event.settings,()=>{settingsReceived=true;ready();});
      session.once(APNS.event.close,()=>{clearTimeout(timer);if(this.session===session)this.session=undefined;if(this.opening===session)this.opening=undefined;reject(new Error(PUSH.failure.unavailable));});
      session.on(APNS.event.goaway,(_code,lastStreamID)=>{this.lastProcessedStream.set(session,lastStreamID);if(this.session===session)this.session=undefined;session.close();});
    });
    this.connecting=pending;
    void pending.then(()=>{if(this.connecting===pending)this.connecting=undefined;},()=>{if(this.connecting===pending)this.connecting=undefined;});
    return pending;
  }
  close():void {this.stopped=true;this.session?.destroy();this.opening?.destroy();this.session=undefined;this.opening=undefined;}
}
