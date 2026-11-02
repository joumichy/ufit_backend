import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {NotificationEmailsWorker} from '../src/modules/notifications/infrastructure/notification-emails.worker';
import {getEnv} from '../src/config/env';
vi.mock('../src/config/env',()=>({getEnv:vi.fn()}));
const FIXTURE={apiKey:'provider-contract-fixture',origin:'https://api.resend.com',otherOrigin:'https://example.invalid',
  address:'notifications@example.invalid',timeoutMs:10_000,sender:'Ufit',otherSender:'Other project'} as const;
function environment(extra:Record<string,unknown>={}) {
  vi.mocked(getEnv).mockReturnValue({NOTIFICATION_EMAIL_ENABLED:true,RESEND_API_KEY:FIXTURE.apiKey,RESEND_FROM_NAME:FIXTURE.sender,
    RESEND_FROM_ADDRESS:FIXTURE.address,RESEND_BASE_URL:FIXTURE.origin,RESEND_TIMEOUT_MS:FIXTURE.timeoutMs,...extra} as ReturnType<typeof getEnv>);
}
function repository(){return {claim:vi.fn().mockResolvedValue([]),finish:vi.fn()};}
beforeEach(()=>{vi.useFakeTimers();vi.clearAllMocks();});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
describe('Notification email worker activation',()=>{
  it('does not claim or contact the provider while email delivery is disabled',async()=>{
    environment({NOTIFICATION_EMAIL_ENABLED:false,RESEND_API_KEY:undefined,RESEND_FROM_NAME:FIXTURE.otherSender});
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch);const emails=repository(),worker=new NotificationEmailsWorker(emails);
    worker.onApplicationBootstrap();await vi.advanceTimersByTimeAsync(30_000);await worker.deliverDue();await worker.onModuleDestroy();
    expect(emails.claim).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
  });
  it.each([{RESEND_FROM_NAME:FIXTURE.otherSender},{RESEND_API_KEY:undefined},{RESEND_FROM_ADDRESS:undefined},
    {RESEND_BASE_URL:FIXTURE.otherOrigin},{RESEND_BASE_URL:FIXTURE.origin+'/other'}, {RESEND_SEND_PATH:'/other'}])
    ('rejects invalid enabled sender or provider configuration before claiming work: %j',extra=>{
      environment(extra);const emails=repository();expect(()=>new NotificationEmailsWorker(emails)).toThrow();expect(emails.claim).not.toHaveBeenCalled();
    });
  it('claims with the configured Ufit sender and stops polling after shutdown',async()=>{
    environment();const emails=repository(),worker=new NotificationEmailsWorker(emails);
    worker.onApplicationBootstrap();await vi.advanceTimersByTimeAsync(2_000);
    expect(emails.claim).toHaveBeenCalledWith({name:FIXTURE.sender,address:FIXTURE.address});
    await worker.onModuleDestroy();await vi.advanceTimersByTimeAsync(30_000);expect(emails.claim).toHaveBeenCalledTimes(1);
  });
});
