import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { getEnv } from '../../../../config/env';
import type { SupabaseJwtClaims } from '../../domain/user.types';

export const AUTH_TOKEN_VERIFIER = Symbol('AUTH_TOKEN_VERIFIER');

export interface AuthTokenVerifier {
  verify(token: string): Promise<SupabaseJwtClaims>;
}

interface JwtHeader {
  alg?: string;
  typ?: string;
}

@Injectable()
export class SupabaseJwtVerifier implements AuthTokenVerifier {
  async verify(token: string): Promise<SupabaseJwtClaims> {
    const env = getEnv();
    const [encodedHeader, encodedPayload, encodedSignature] = token.split('.');

    if (!encodedHeader || !encodedPayload || !encodedSignature) {
      throw new UnauthorizedException('Invalid bearer token');
    }

    const header = this.decodeJson<JwtHeader>(encodedHeader);
    const payload = this.decodeJson<SupabaseJwtClaims>(encodedPayload);

    if (!payload.sub) {
      throw new UnauthorizedException('Invalid Supabase token subject');
    }

    if (!env.SUPABASE_JWT_SECRET) {
      if (env.NODE_ENV === 'test') {
        return payload;
      }

      throw new UnauthorizedException('Supabase JWT verification is not configured');
    }

    if (!header.alg || !['HS256', 'HS384', 'HS512'].includes(header.alg)) {
      throw new UnauthorizedException('Unsupported Supabase JWT algorithm');
    }

    const expectedSignature = this.sign(`${encodedHeader}.${encodedPayload}`, env.SUPABASE_JWT_SECRET, header.alg);
    const actualSignature = this.base64UrlToBuffer(encodedSignature);

    if (expectedSignature.length !== actualSignature.length || !timingSafeEqual(expectedSignature, actualSignature)) {
      throw new UnauthorizedException('Invalid bearer token signature');
    }

    return payload;
  }

  private sign(input: string, secret: string, algorithm: string): Buffer {
    const digest = algorithm.replace('HS', 'sha');
    const encoded = createHmac(digest, secret).update(input).digest('base64url');
    return this.base64UrlToBuffer(encoded);
  }

  private decodeJson<T>(input: string): T {
    try {
      return JSON.parse(Buffer.from(input, 'base64url').toString('utf8')) as T;
    } catch {
      throw new UnauthorizedException('Invalid bearer token payload');
    }
  }

  private base64UrlToBuffer(input: string): Buffer {
    return Buffer.from(input, 'base64url');
  }
}
