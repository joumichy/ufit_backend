import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env';

const requiredEnv = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_DIRECT_CONNECTION_DB_URL: 'postgres://user:pass@localhost:5432/postgres'
};

describe('parseEnv', () => {
  it('uses safe defaults for the backend foundation', () => {
    const env = parseEnv(requiredEnv);

    expect(env.API_PORT).toBe(4000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.UFIT_DB_SCHEMA).toBe('ufit');
    expect(env.SUPABASE_DB_SSL).toBe(true);
    expect(env.SUPABASE_DB_TLS_REJECT_UNAUTHORIZED).toBe(false);
  });

  it('rejects invalid schema names', () => {
    expect(() =>
      parseEnv({
        ...requiredEnv,
        UFIT_DB_SCHEMA: 'ufit;drop schema public'
      })
    ).toThrow(/UFIT_DB_SCHEMA/);
  });

  it('parses explicit boolean flags', () => {
    const env = parseEnv({
      ...requiredEnv,
      SUPABASE_DB_SSL: 'false',
      SUPABASE_DB_TLS_REJECT_UNAUTHORIZED: 'true'
    });

    expect(env.SUPABASE_DB_SSL).toBe(false);
    expect(env.SUPABASE_DB_TLS_REJECT_UNAUTHORIZED).toBe(true);
  });

  it('treats empty optional Supabase values as absent', () => {
    const env = parseEnv({
      ...requiredEnv,
      SUPABASE_PUBLIC_KEY: '',
      SUPABASE_SECRET_KEY: '',
      SUPABASE_JWT_SECRET: '',
      SUPABASE_DB_CA_CERT: ''
    });

    expect(env.SUPABASE_PUBLIC_KEY).toBeUndefined();
    expect(env.SUPABASE_SECRET_KEY).toBeUndefined();
    expect(env.SUPABASE_JWT_SECRET).toBeUndefined();
    expect(env.SUPABASE_DB_CA_CERT).toBeUndefined();
  });
});
