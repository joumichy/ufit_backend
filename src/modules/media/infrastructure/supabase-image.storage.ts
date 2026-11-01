import { createHash } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getEnv } from '../../../config/env';
import type {ImageStorage, ImageStorageConfiguration} from '../domain/image-upload.contract';

export class SupabaseImageStorage implements ImageStorage {
  private client?: SupabaseClient;
  constructor(private readonly configuration: ImageStorageConfiguration) {}
  private bucket() {
    const env = getEnv();
    if (!env.SUPABASE_SECRET_KEY) throw new ServiceUnavailableException(this.configuration.failure.configuration);
    this.client ??= createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {auth: {persistSession: false, autoRefreshToken: false, detectSessionInUrl: false}});
    return this.client.storage.from(this.configuration.bucket);
  }
  async uploadOrVerify(path: string, bytes: Buffer, fingerprint: string): Promise<void> {
    const bucket = this.bucket();
    const result = await bucket.upload(path, bytes, {contentType: this.configuration.mime, upsert: this.configuration.storageSettings.upsert, cacheControl: this.configuration.storageSettings.cacheControl});
    if (!result.error) return;
    // A response may be lost after storage accepted the object; verify the immutable path before retrying.
    const existing = await bucket.download(path);
    if (existing.error || !existing.data) throw new ServiceUnavailableException(this.configuration.failure.unavailable);
    const stored = Buffer.from(await existing.data.arrayBuffer());
    if (stored.length !== bytes.length || createHash(this.configuration.hash.algorithm).update(stored).digest(this.configuration.hash.encoding) !== fingerprint) {
      throw new ServiceUnavailableException(this.configuration.failure.unavailable);
    }
  }
  async sign(paths: string[]): Promise<Map<string, string>> {
    if (!paths.length) return new Map();
    const unique = [...new Set(paths)];
    const result = await this.bucket().createSignedUrls(unique, this.configuration.storageSettings.signedSeconds);
    if (result.error || !result.data) throw new ServiceUnavailableException(this.configuration.failure.unavailable);
    const signed = new Map<string, string>();
    for (const item of result.data) {
      if (item.error || !item.path || !unique.includes(item.path) || !item.signedUrl || signed.has(item.path)) throw new ServiceUnavailableException(this.configuration.failure.unavailable);
      signed.set(item.path, item.signedUrl);
    }
    if (signed.size !== unique.length) throw new ServiceUnavailableException(this.configuration.failure.unavailable);
    return signed;
  }
}
