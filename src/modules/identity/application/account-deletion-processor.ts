import type {ImageErasureStorage} from '../../media/domain/image-upload.contract';
import {ACCOUNT_DELETION as D,AccountDeletionAuthorityFailure,type AccountDeletionAuthority,
  type AccountDeletionMediaKind} from '../domain/account-deletion.contract';
import {DrizzleAccountDeletionQueue} from '../infrastructure/persistence/drizzle-account-deletion-queue';

export class AccountDeletionProcessor {
  constructor(private readonly queue:DrizzleAccountDeletionQueue,
    private readonly media:Readonly<Record<AccountDeletionMediaKind,ImageErasureStorage>>,
    private readonly authority:AccountDeletionAuthority,
    private readonly now:()=>Date=()=>new Date()) {}

  // True means work was reserved; completion is recorded only by the queue.
  async runNext():Promise<boolean> {
    const lease=await this.queue.reserve(this.now());
    if(!lease)return false;
    try {
      if(lease.phase===D.phase.purging){
        for(const target of await this.queue.targets(lease,this.now())){
          await this.media[target.kind].eraseOrVerify(target.objectPath);
          if(!await this.queue.acknowledgeMedia(lease,target,this.now()))return true;
        }
        if(!await this.queue.advanceToAuth(lease,this.now()))await this.queue.release(lease,this.now());
      }else{
        await this.authority.erase(lease.authUserId);
        await this.queue.complete(lease,this.now());
      }
    }catch(error){
      const reason=error instanceof AccountDeletionAuthorityFailure?error.reason:
        lease.phase===D.phase.purging?D.retry.storage:D.retry.auth;
      await this.queue.retry(lease,reason,this.now());
    }
    return true;
  }
}
