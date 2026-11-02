import {Inject,Injectable,type OnApplicationBootstrap,type OnModuleDestroy} from '@nestjs/common';
import {ACCOUNT_DELETION as D} from '../domain/account-deletion.contract';
import {AccountDeletionProcessor} from '../application/account-deletion-processor';

@Injectable()
export class AccountDeletionsWorker implements OnApplicationBootstrap,OnModuleDestroy {
  private timer?:ReturnType<typeof setTimeout>;
  private running?:Promise<void>;
  private stopped=false;
  constructor(@Inject(D.token.processor) private readonly processor:Pick<AccountDeletionProcessor,'runNext'>) {}
  onApplicationBootstrap():void {this.schedule();}
  private schedule():void {
    if(this.stopped)return;
    this.timer=setTimeout(()=>{
      this.running=this.processDue();
      void this.running.then(()=>this.schedule(),()=>this.schedule());
    },D.worker.pollMs);
    this.timer.unref();
  }
  async processDue():Promise<void> {
    for(let step=D.limits.zero;step<D.worker.maximumSteps&&!this.stopped;step++)if(!await this.processor.runNext())return;
  }
  async onModuleDestroy():Promise<void> {this.stopped=true;clearTimeout(this.timer);await this.running?.catch(()=>undefined);}
}
