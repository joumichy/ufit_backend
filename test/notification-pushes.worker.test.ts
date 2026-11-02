import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {getEnv} from '../src/config/env';
import {NotificationPushesWorker} from '../src/modules/notifications/infrastructure/notification-pushes.worker';
import {ApnsPushTransport} from '../src/modules/notifications/infrastructure/apns-push.transport';
import {PUSH_DELIVERY as P} from '../src/modules/notifications/domain/push-delivery';
import {NOTIFICATION_PUSH as N,reservedPushSchema,startedPushSchema,pushTransportResultSchema} from '../src/modules/notifications/domain/notification-push.contract';
vi.mock('../src/config/env',()=>({getEnv:vi.fn()}));
const FIXTURE={keyId:'ABCDEFGHIJ',teamId:'KLMNOPQRST',curve:'prime256v1',type:'pkcs8',format:'pem',keyKind:'ec',token:'00ab',
  expiryMs:60_000,invalidToken:'ABC',invalidOutcome:'received',unavailable:'unavailable'} as const;
const privateKey=generateKeyPairSync(FIXTURE.keyKind,{namedCurve:FIXTURE.curve}).privateKey.export({type:FIXTURE.type,format:FIXTURE.format}).toString();
function environment(extra:Record<string,unknown>={}){vi.mocked(getEnv).mockReturnValue({NOTIFICATION_PUSH_ENABLED:true,
  APNS_ENVIRONMENT:P.environment.development,APNS_KEY_ID:FIXTURE.keyId,APNS_TEAM_ID:FIXTURE.teamId,APNS_PRIVATE_KEY:privateKey,...extra} as ReturnType<typeof getEnv>);}
function fixture(){const reservation={id:randomUUID(),installationId:randomUUID(),associationId:randomUUID(),leaseToken:randomUUID()};
  return {...reservation,attempts:N.limits.one,registrationId:randomUUID(),attemptedAt:new Date(),
    push:{deliveryId:reservation.id,notificationId:randomUUID(),deviceToken:FIXTURE.token,environment:P.environment.development,expiresAt:new Date(Date.now()+FIXTURE.expiryMs)}};}
function repository(){const attempt=fixture();return {claim:vi.fn().mockResolvedValue([reservedPushSchema.parse({id:attempt.id,installationId:attempt.installationId,
  associationId:attempt.associationId,leaseToken:attempt.leaseToken})]),start:vi.fn().mockResolvedValue(attempt),finish:vi.fn().mockResolvedValue(true),attempt};}
beforeEach(()=>{vi.useFakeTimers();vi.clearAllMocks();});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
describe('Push worker',()=>{
  it('does not reserve, construct a sender or connect when disabled',async()=>{
    environment({NOTIFICATION_PUSH_ENABLED:false,APNS_PRIVATE_KEY:undefined});const repo=repository(),worker=new NotificationPushesWorker(repo),send=vi.spyOn(ApnsPushTransport.prototype,'send');
    worker.onApplicationBootstrap();await vi.advanceTimersByTimeAsync(N.limits.pollMs);await worker.deliverDue();await worker.onModuleDestroy();expect(repo.claim).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();
  });
  it.each([{APNS_ENVIRONMENT:undefined},{APNS_KEY_ID:undefined},{APNS_TEAM_ID:undefined},{APNS_PRIVATE_KEY:undefined},
    {APNS_ENVIRONMENT:'other'},{APNS_KEY_ID:FIXTURE.unavailable},{APNS_PRIVATE_KEY:FIXTURE.unavailable}])('fails enabled invalid configuration before reserving: %j',extra=>{
    environment(extra);const repo=repository();expect(()=>new NotificationPushesWorker(repo)).toThrow();expect(repo.claim).not.toHaveBeenCalled();
  });
  it('persists the start before passing the exact reserved envelope to transport and finishing it',async()=>{
    environment();const repo=repository(),result={outcome:P.outcome.accepted,providerMessageId:repo.attempt.id} as const;
    const send=vi.spyOn(ApnsPushTransport.prototype,'send').mockImplementation(async delivery=>{
      expect(repo.start).toHaveBeenCalledWith((await repo.claim.mock.results[N.limits.zero].value)[N.limits.zero]);expect(delivery).toEqual(repo.attempt.push);return result;
    });
    const worker=new NotificationPushesWorker(repo);await worker.deliverDue();expect(repo.claim).toHaveBeenCalledWith(P.environment.development);
    expect(send).toHaveBeenCalledTimes(N.limits.one);expect(repo.finish).toHaveBeenCalledWith(repo.attempt,result);await worker.onModuleDestroy();
  });
  it('does not send a cancelled or obsolete reservation',async()=>{
    environment();const repo=repository();repo.start.mockResolvedValue(null);const send=vi.spyOn(ApnsPushTransport.prototype,'send');const worker=new NotificationPushesWorker(repo);
    await worker.deliverDue();expect(send).not.toHaveBeenCalled();expect(repo.finish).not.toHaveBeenCalled();await worker.onModuleDestroy();
  });
  it('records unexpected sender failure as uncertain, without an internal repost',async()=>{
    environment();const repo=repository(),send=vi.spyOn(ApnsPushTransport.prototype,'send').mockRejectedValue(new Error(FIXTURE.unavailable));const worker=new NotificationPushesWorker(repo);
    await worker.deliverDue();expect(send).toHaveBeenCalledTimes(N.limits.one);expect(repo.finish).toHaveBeenCalledWith(repo.attempt,{outcome:P.outcome.unknown,reason:P.failure.transport});await worker.onModuleDestroy();
  });
  it('releases a started but unsent attempt safely if shutdown occurs while start commits',async()=>{
    environment();const repo=repository();let resume!:(value:typeof repo.attempt)=>void;repo.start.mockImplementation(()=>new Promise(resolve=>{resume=resolve;}));
    const send=vi.spyOn(ApnsPushTransport.prototype,'send'),worker=new NotificationPushesWorker(repo),pending=worker.deliverDue();
    await Promise.resolve();await worker.onModuleDestroy();resume(repo.attempt);await pending;
    expect(send).not.toHaveBeenCalled();expect(repo.finish).toHaveBeenCalledWith(repo.attempt,{outcome:P.outcome.retry,reason:P.failure.closed,retryAfterMs:N.limits.firstRetryMs});
  });
  it('stops polling and closes transport on shutdown',async()=>{
    environment();const repo=repository();repo.claim.mockResolvedValue([]);const close=vi.spyOn(ApnsPushTransport.prototype,'close');const worker=new NotificationPushesWorker(repo);
    worker.onApplicationBootstrap();await vi.advanceTimersByTimeAsync(N.limits.pollMs);expect(repo.claim).toHaveBeenCalledTimes(N.limits.one);await worker.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(N.limits.pollMs);expect(repo.claim).toHaveBeenCalledTimes(N.limits.one);expect(close).toHaveBeenCalledTimes(N.limits.one);
  });
});
describe('Push lifecycle boundary',()=>{
  it('accepts the canonical envelope and rejects a recipient or token alias',()=>{const attempt=fixture();expect(startedPushSchema.safeParse(attempt).success).toBe(true);
    expect(startedPushSchema.safeParse({...attempt,userId:randomUUID()}).success).toBe(false);expect(startedPushSchema.safeParse({...attempt,push:{...attempt.push,deviceToken:FIXTURE.invalidToken}}).success).toBe(false);});
  it.each([{outcome:FIXTURE.invalidOutcome},{outcome:P.outcome.accepted,providerMessageId:randomUUID(),received:true},
    {outcome:P.outcome.retry,reason:P.failure.unavailable,retryAfterMs:-N.limits.one},
    {outcome:P.outcome.invalidDevice,reason:P.failure.device}])('rejects malformed provider completion: %j',result=>{expect(pushTransportResultSchema.safeParse(result).success).toBe(false);});
});
