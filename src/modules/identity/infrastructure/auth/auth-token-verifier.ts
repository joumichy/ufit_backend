import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getEnv } from '../../../../config/env';
import type { SupabaseJwtClaims } from '../../domain/user.types';

export const AUTH_TOKEN_VERIFIER = Symbol('AUTH_TOKEN_VERIFIER');
export interface AuthTokenVerifier {
  verify(token: string): Promise<SupabaseJwtClaims>;
}

const AUTH_FAILURE = {
  configuration: 'Supabase authentication is not configured',
  token: 'Invalid or expired bearer token'
} as const;

@Injectable()
export class SupabaseJwtVerifier implements AuthTokenVerifier {
  private client?: SupabaseClient;

  async verify(token: string): Promise<SupabaseJwtClaims> {
    const env = getEnv();
    if (!env.SUPABASE_PUBLIC_KEY) throw new UnauthorizedException(AUTH_FAILURE.configuration);
    this.client ??= createClient(env.SUPABASE_URL, env.SUPABASE_PUBLIC_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
    // The auth authority validates expiry, signature and project identity for us.
    const { data, error } = await this.client.auth.getUser(token);
    if (error || !data.user) throw new UnauthorizedException(AUTH_FAILURE.token);
    return { sub: data.user.id, email: data.user.email, user_metadata: data.user.user_metadata };
  }
}
