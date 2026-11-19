import {Inject,Injectable,type OnApplicationBootstrap,type OnModuleDestroy} from '@nestjs/common';
import {getEnv} from '../../../config/env';
import {NOTIFICATION_EMAIL,notificationSenderSchema,type NotificationSender} from '../domain/notification-email.contract';
import {DrizzleNotificationEmailsRepository} from './drizzle-notification-emails.repository';
import {RESEND_EMAIL,ResendEmailTransport} from './resend-email.transport';
import {EMAIL_DELIVERY,EMAIL_PROVIDER,type EmailProvider,type EmailTransport} from '../domain/email-delivery';
import type {NotificationDeliveryScope} from '../domain/notification-delivery-scope';
import {DEVELOPMENT_NOTIFICATIONS,developmentNotificationsConfiguration} from './development-notifications.configuration';
import {MailpitEmailTransport} from './mailpit-email.transport';

@Injectable()
export class NotificationEmailsWorker implements OnApplicationBootstrap,OnModuleDestroy {
  private timer?:ReturnType<typeof setTimeout>;
  private running?:Promise<void>;
  private stopped=false;
  private readonly sender?:NotificationSender;
  private readonly transport?:EmailTransport;
  private readonly scope?:NotificationDeliveryScope;
  private readonly provider:EmailProvider=EMAIL_PROVIDER.resend;
  constructor(@Inject(DrizzleNotificationEmailsRepository) private readonly emails:Pick<DrizzleNotificationEmailsRepository,'claim'|'finish'>) {
    const env=getEnv();
    const development=developmentNotificationsConfiguration(env);
    if(development){
      if(!development.emailEnabled)return;
      this.sender={name:NOTIFICATION_EMAIL.senderName,address:DEVELOPMENT_NOTIFICATIONS.senderAddress};
      this.scope=development.scope;this.provider=EMAIL_PROVIDER.mailpit;
      this.transport=new MailpitEmailTransport({origin:development.mailpitOrigin,timeoutMs:EMAIL_DELIVERY.limits.defaultTimeoutMs});
      return;
    }
    if(!env.NOTIFICATION_EMAIL_ENABLED)return;
    const sender=notificationSenderSchema.safeParse({name:env.RESEND_FROM_NAME??NOTIFICATION_EMAIL.senderName,address:env.RESEND_FROM_ADDRESS});
    const origin=new URL(env.RESEND_BASE_URL??RESEND_EMAIL.origin);
    if(!sender.success||sender.data.name!==NOTIFICATION_EMAIL.senderName||!env.RESEND_API_KEY||
      origin.origin!==RESEND_EMAIL.origin||origin.pathname!==RESEND_EMAIL.rootPath||
      (env.RESEND_SEND_PATH!==undefined&&env.RESEND_SEND_PATH!==RESEND_EMAIL.path)) {
      throw new Error(NOTIFICATION_EMAIL.failure.configuration);
    }
    this.sender=sender.data;
    this.transport=new ResendEmailTransport({apiKey:env.RESEND_API_KEY,timeoutMs:env.RESEND_TIMEOUT_MS});
  }
  onApplicationBootstrap():void {if(this.sender&&this.transport)this.schedule();}
  private schedule():void {
    if(this.stopped)return;
    this.timer=setTimeout(()=>{
      this.running=this.deliverDue();
      void this.running.then(()=>this.schedule(),()=>this.schedule());
    },NOTIFICATION_EMAIL.limits.pollMs);
    this.timer.unref();
  }
  async deliverDue():Promise<void> {
    if(!this.sender||!this.transport||this.stopped)return;
    const claimed=this.scope?await this.emails.claim(this.sender,new Date(),this.scope,this.provider):await this.emails.claim(this.sender);
    await Promise.allSettled(claimed.map(async claim=>{
      const result=await this.transport!.send(claim.email);
      await this.emails.finish(claim,result);
    }));
  }
  async onModuleDestroy():Promise<void> {
    this.stopped=true;clearTimeout(this.timer);await this.running?.catch(()=>undefined);
  }
}
