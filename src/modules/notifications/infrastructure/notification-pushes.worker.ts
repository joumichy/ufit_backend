import {Inject,Injectable,type OnApplicationBootstrap,type OnModuleDestroy} from '@nestjs/common';
import {getEnv} from '../../../config/env';
import {PUSH_DELIVERY as PUSH,type PushEnvironment,type PushTransportResult} from '../domain/push-delivery';
import {NOTIFICATION_PUSH as N} from '../domain/notification-push.contract';
import {DrizzleNotificationPushesRepository} from './drizzle-notification-pushes.repository';
import {ApnsPushTransport} from './apns-push.transport';
import type {NotificationDeliveryScope} from '../domain/notification-delivery-scope';
import {developmentNotificationsConfiguration,developmentApnsConfiguration} from './development-notifications.configuration';

@Injectable()
export class NotificationPushesWorker implements OnApplicationBootstrap,OnModuleDestroy {
  private timer?:ReturnType<typeof setTimeout>;
  private running?:Promise<void>;
  private stopped=false;
  private readonly environment?:PushEnvironment;
  private readonly transport?:ApnsPushTransport;
  private readonly scope?:NotificationDeliveryScope;
  constructor(@Inject(DrizzleNotificationPushesRepository) private readonly pushes:Pick<DrizzleNotificationPushesRepository,'claim'|'start'|'finish'>) {
    const env=getEnv();
    const development=developmentNotificationsConfiguration(env);
    if(development){
      if(!development.pushEnabled)return;
      const configuration=developmentApnsConfiguration(development.appleRegistryPath);
      this.scope=development.scope;this.environment=configuration.environment;
      this.transport=new ApnsPushTransport(configuration);
      return;
    }
    if(!env.NOTIFICATION_PUSH_ENABLED)return;
    if(!env.APNS_ENVIRONMENT)throw new Error(PUSH.failure.configuration);
    this.environment=env.APNS_ENVIRONMENT;
    this.transport=new ApnsPushTransport({environment:this.environment,keyId:env.APNS_KEY_ID!,teamId:env.APNS_TEAM_ID!,
      privateKey:env.APNS_PRIVATE_KEY!,timeoutMs:env.APNS_TIMEOUT_MS});
  }
  onApplicationBootstrap():void {if(this.transport)this.schedule();}
  private schedule():void {
    if(this.stopped)return;
    this.timer=setTimeout(()=>{
      this.running=this.deliverDue();
      void this.running.then(()=>this.schedule(),()=>this.schedule());
    },N.limits.pollMs);
    this.timer.unref();
  }
  async deliverDue():Promise<void> {
    if(!this.transport||!this.environment||this.stopped)return;
    const reservations=this.scope?await this.pushes.claim(this.environment,new Date(),this.scope):await this.pushes.claim(this.environment);
    await Promise.allSettled(reservations.map(async reservation=>{
      if(this.stopped)return;
      const attempt=await this.pushes.start(reservation);
      if(!attempt)return;
      let result:PushTransportResult;
      if(this.stopped)result={outcome:PUSH.outcome.retry,reason:PUSH.failure.closed,retryAfterMs:N.limits.firstRetryMs};
      else {
        try {result=await this.transport!.send(attempt.push);}
        catch {result={outcome:PUSH.outcome.unknown,reason:PUSH.failure.transport};}
      }
      await this.pushes.finish(attempt,result);
    }));
  }
  async onModuleDestroy():Promise<void> {
    this.stopped=true;clearTimeout(this.timer);this.transport?.close();await this.running?.catch(()=>undefined);
  }
}
