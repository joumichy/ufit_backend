import {createClient, type SupabaseClient, type User} from '@supabase/supabase-js';
import {getEnv} from '../../../../config/env';
import {ACCOUNT_DELETION as D,AccountDeletionAuthorityFailure,deletionIdentifierSchema,
  type AccountDeletionAuthority} from '../../domain/account-deletion.contract';

function configuredClient():SupabaseClient {
  const env=getEnv();
  if(!env.SUPABASE_SECRET_KEY)throw new AccountDeletionAuthorityFailure(D.retry.auth);
  return createClient(env.SUPABASE_URL,env.SUPABASE_SECRET_KEY,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
}

export class SupabaseAccountDeletion implements AccountDeletionAuthority {
  private client?:SupabaseClient;
  constructor(private readonly factory:()=>SupabaseClient=configuredClient) {}

  private subject(rawId:string):string {
    const parsed=deletionIdentifierSchema.safeParse(rawId);
    if(!parsed.success)throw new AccountDeletionAuthorityFailure(D.retry.auth);
    this.client??=this.factory();
    return parsed.data;
  }
  async prepare(rawId:string):Promise<void> {
    const id=this.subject(rawId),current=await this.read(id);
    if(current===null)throw new AccountDeletionAuthorityFailure(D.retry.auth);
    this.requireRevocable(current,id);
  }
  async erase(rawId:string):Promise<void> {
    const id=this.subject(rawId);
    const current=await this.read(id);
    if(current===null)return;
    this.requireRevocable(current,id);
    try {await this.client!.auth.admin.deleteUser(id,D.auth.softDelete);} catch {}
    // Neither a successful response nor a lost acknowledgement proves absence.
    if(await this.read(id)!==null)throw new AccountDeletionAuthorityFailure(D.retry.auth);
  }
  private requireRevocable(current:User,id:string):void {
    if(!Array.isArray(current.identities) || current.identities.some(identity=>
      identity.user_id!==id || typeof identity.provider!==D.validation.stringType || !identity.provider.length)) {
      throw new AccountDeletionAuthorityFailure(D.retry.auth);
    }
    if(current.identities.some(identity=>identity.provider===D.auth.appleProvider)) {
      throw new AccountDeletionAuthorityFailure(D.retry.apple);
    }
  }

  private async read(id:string):Promise<User|null> {
    const result=await this.client!.auth.admin.getUserById(id);
    if(result.error){
      if(result.error.status===D.auth.missingUserStatus && result.error.code===D.auth.missingUserCode && result.data.user===null)return null;
      throw new AccountDeletionAuthorityFailure(D.retry.auth);
    }
    if(!result.data.user || result.data.user.id!==id)throw new AccountDeletionAuthorityFailure(D.retry.auth);
    return result.data.user;
  }
}
