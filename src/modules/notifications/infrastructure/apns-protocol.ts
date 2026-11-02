import type {IncomingHttpHeaders} from 'node:http2';
import {z} from 'zod';
import {PUSH_DELIVERY as PUSH,type PushTransportResult} from '../domain/push-delivery';

export const APNS = {
  origin:{development:'https://api.sandbox.push.apple.com',production:'https://api.push.apple.com'},
  topic:'com.stellark.ufit',
  path:'/3/device/',method:'POST',scheme:'https',
  event:{response:'response',data:'data',error:'error',aborted:'aborted',close:'close',end:'end',connect:'connect',goaway:'goaway',settings:'remoteSettings'},
  header:{method:':method',path:':path',authority:':authority',scheme:':scheme',status:':status',id:'apns-id',topic:'apns-topic',
    type:'apns-push-type',priority:'apns-priority',expiration:'apns-expiration',collapse:'apns-collapse-id',authorization:'authorization',content:'content-type'},
  value:{alert:'alert',priority:'10',content:'application/json',bearer:'bearer ',sound:'default'},
  jwt:{algorithm:'ES256',curve:'prime256v1',keyType:'ec',signing:'sha256',signature:'ieee-p1363',encoding:'base64url',separator:'.',identifier:/^[A-Za-z0-9]{10}$/},
  limits:{secondMs:1_000,tokenReuseMs:45*60*1_000,defaultTimeoutMs:10_000,maximumTimeoutMs:15_000,responseBytes:8_192,
    payloadBytes:4_096,minimum:1,zero:0,serverRetryMs:15*60*1_000,rateRetryMs:60*1_000,tokenRetryMs:20*60*1_000},
  status:{accepted:200,bad:400,credentials:403,unregistered:410,rate:429,internal:500,unavailable:503,clientMinimum:400,clientMaximum:499},
  reason:{badDevice:'BadDeviceToken',topic:'DeviceTokenNotForTopic',unregistered:'Unregistered',expired:'ExpiredToken',rate:'TooManyRequests',
    tokenRate:'TooManyProviderTokenUpdates',internal:'InternalServerError',unavailable:'ServiceUnavailable',shutdown:'Shutdown'},
} as const;

const responseSchema=z.object({reason:z.string().min(APNS.limits.minimum),timestamp:z.number().int().nonnegative().safe().optional()}).strict();
const statusSchema=z.number().int();

export function apnsResponse(headers:IncomingHttpHeaders,body:Buffer,deliveryId:string):PushTransportResult {
  const unknown={outcome:PUSH.outcome.unknown,reason:PUSH.failure.response} as const;
  if(headers[APNS.header.id]!==deliveryId)return unknown;
  const parsedStatus=statusSchema.safeParse(headers[APNS.header.status]);
  if(!parsedStatus.success)return unknown;
  const status=parsedStatus.data;
  if(status===APNS.status.accepted)return body.length===APNS.limits.zero?{outcome:PUSH.outcome.accepted,providerMessageId:deliveryId}:unknown;
  let parsed:z.infer<typeof responseSchema>;
  try {parsed=responseSchema.parse(JSON.parse(body.toString()));}catch{return unknown;}
  const {reason,timestamp}=parsed;
  if((status===APNS.status.unregistered)!==(timestamp!==undefined))return unknown;
  if(status===APNS.status.unregistered){
    if(reason!==APNS.reason.unregistered&&reason!==APNS.reason.expired)return unknown;
    const invalidatedAt=new Date(timestamp!);
    return Number.isFinite(invalidatedAt.getTime())?{outcome:PUSH.outcome.invalidDevice,reason:PUSH.failure.device,invalidatedAt}:unknown;
  }
  if(status===APNS.status.bad&&(reason===APNS.reason.badDevice||reason===APNS.reason.topic)) {
    return {outcome:PUSH.outcome.invalidDevice,reason:PUSH.failure.device,invalidatedAt:null};
  }
  if(status===APNS.status.rate&&(reason===APNS.reason.rate||reason===APNS.reason.tokenRate)) {
    return {outcome:PUSH.outcome.retry,reason:reason===APNS.reason.rate?PUSH.failure.rate:PUSH.failure.tokenRate,
      retryAfterMs:reason===APNS.reason.rate?APNS.limits.rateRetryMs:APNS.limits.tokenRetryMs};
  }
  if(status===APNS.status.internal&&reason===APNS.reason.internal||status===APNS.status.unavailable&&(reason===APNS.reason.unavailable||reason===APNS.reason.shutdown)) {
    return {outcome:PUSH.outcome.retry,reason:PUSH.failure.unavailable,retryAfterMs:APNS.limits.serverRetryMs};
  }
  if(status===APNS.status.credentials)return {outcome:PUSH.outcome.rejected,reason:PUSH.failure.credentials};
  if(status>=APNS.status.clientMinimum&&status<=APNS.status.clientMaximum)return {outcome:PUSH.outcome.rejected,reason:PUSH.failure.request};
  return unknown;
}
