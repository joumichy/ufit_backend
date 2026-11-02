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

  async erase(rawId:string):Promise<void> {
    const parsed=deletionIdentifierSchema.safeParse(rawId);
    if(!parsed.success)throw new AccountDeletionAuthorityFailure(D.retry.auth);
    const id=parsed.data;
    this.client??=this.factory();
    const current=await this.read(id);
    if(current===null)return;
    if(!Array.isArray(current.identities) || current.identities.some(identity=>
      identity.user_id!==id || typeof identity.provider!=='string' || !identity.provider.length)) {
      throw new AccountDeletionAuthorityFailure(D.retry.auth);
    }
    if(current.identities.some(identity=>identity.provider===D.auth.appleProvider)) {
      throw new AccountDeletionAuthorityFailure(D.retry.apple);
    }
    try {await this.client.auth.admin.deleteUser(id,D.auth.softDelete);} catch {}
    // Neither a successful response nor a lost acknowledgement proves absence.
    if(await this.read(id)!==null)throw new AccountDeletionAuthorityFailure(D.retry.auth);
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
