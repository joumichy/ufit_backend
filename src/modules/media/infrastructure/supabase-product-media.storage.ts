import { createHash } from 'node:crypto';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getEnv } from '../../../config/env';
import { PRODUCT_MEDIA } from '../domain/product-media.contract';
import type { ProductMediaStorage } from '../domain/product-media.types';

@Injectable()
export class SupabaseProductMediaStorage implements ProductMediaStorage {
  private client?: SupabaseClient;
  private bucket() {
    const env = getEnv();
    if (!env.SUPABASE_SECRET_KEY) throw new ServiceUnavailableException(PRODUCT_MEDIA.failure.configuration);
    this.client ??= createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {auth: {persistSession: false, autoRefreshToken: false, detectSessionInUrl: false}});
    return this.client.storage.from(PRODUCT_MEDIA.bucket);
  }
  async uploadOrVerify(path: string, bytes: Buffer, fingerprint: string): Promise<void> {
    const bucket = this.bucket();
    const result = await bucket.upload(path, bytes, {contentType: PRODUCT_MEDIA.mime, upsert: PRODUCT_MEDIA.storageSettings.upsert, cacheControl: PRODUCT_MEDIA.storageSettings.cacheControl});
    if (!result.error) return;
    // A response may be lost after storage accepted the object; verify the immutable path before retrying.
    const existing = await bucket.download(path);
    if (existing.error || !existing.data) throw new ServiceUnavailableException(PRODUCT_MEDIA.failure.unavailable);
    const stored = Buffer.from(await existing.data.arrayBuffer());
    if (stored.length !== bytes.length || createHash(PRODUCT_MEDIA.hash.algorithm).update(stored).digest(PRODUCT_MEDIA.hash.encoding) !== fingerprint) {
      throw new ServiceUnavailableException(PRODUCT_MEDIA.failure.unavailable);
    }
  }
  async sign(paths: string[]): Promise<Map<string, string>> {
    if (!paths.length) return new Map();
    const unique = [...new Set(paths)];
    const result = await this.bucket().createSignedUrls(unique, PRODUCT_MEDIA.storageSettings.signedSeconds);
    if (result.error || !result.data) throw new ServiceUnavailableException(PRODUCT_MEDIA.failure.unavailable);
    const signed = new Map<string, string>();
    for (const item of result.data) {
      if (item.error || !item.path || !unique.includes(item.path) || !item.signedUrl || signed.has(item.path)) throw new ServiceUnavailableException(PRODUCT_MEDIA.failure.unavailable);
      signed.set(item.path, item.signedUrl);
    }
    if (signed.size !== unique.length) throw new ServiceUnavailableException(PRODUCT_MEDIA.failure.unavailable);
    return signed;
  }
}
