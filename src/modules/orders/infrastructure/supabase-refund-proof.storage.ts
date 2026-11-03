import {createHash} from 'node:crypto';
import {ServiceUnavailableException} from '@nestjs/common';
import {createClient,type SupabaseClient} from '@supabase/supabase-js';
import {getEnv} from '../../../config/env';
import {REFUND_PROOF as P,type RefundProofAsset,type RefundProofStorage} from '../domain/refund-proof.contract';
import {REFUND_ORGANIZATION as O} from '../domain/refund-organization';

export class SupabaseRefundProofStorage implements RefundProofStorage {
  private client?:SupabaseClient;
  constructor(private readonly factory?:()=>SupabaseClient) {}
  private bucket() {
    if(!this.client){
      if(this.factory)this.client=this.factory();
      else {
        const env=getEnv();
        if(!env.SUPABASE_SECRET_KEY)throw new ServiceUnavailableException(P.failure.configuration);
        this.client=createClient(env.SUPABASE_URL,env.SUPABASE_SECRET_KEY,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
      }
    }
    return this.client.storage.from(P.bucket);
  }
  async uploadOrVerify(asset:RefundProofAsset,bytes:Buffer):Promise<void> {
    this.assertBytes(asset,bytes);
    const result=await this.bucket().upload(asset.objectPath,bytes,{contentType:asset.contentType,upsert:P.storageSettings.upsert,cacheControl:P.storageSettings.cacheControl});
    if(result.error)await this.download(asset);
  }
  async download(asset:RefundProofAsset):Promise<Buffer> {
    const result=await this.bucket().download(asset.objectPath);
    if(result.error || !result.data)throw new ServiceUnavailableException(P.failure.unavailable);
    const bytes=Buffer.from(await result.data.arrayBuffer());
    this.assertBytes(asset,bytes);return bytes;
  }
  private assertBytes(asset:RefundProofAsset,bytes:Buffer) {
    if(bytes.length!==asset.byteSize || createHash(O.hash.algorithm).update(bytes).digest(O.hash.encoding)!==asset.sha256)throw new ServiceUnavailableException(P.failure.unavailable);
  }
}
