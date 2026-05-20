import { describe, expect, it } from 'vitest';
import { buildPgSslConfig } from '../src/shared/infrastructure/database/pg-ssl';

describe('buildPgSslConfig', () => {
  it('disables ssl only when explicitly configured', () => {
    expect(
      buildPgSslConfig({
        SUPABASE_DB_SSL: false,
        SUPABASE_DB_TLS_REJECT_UNAUTHORIZED: false,
        SUPABASE_DB_CA_CERT: undefined
      })
    ).toBe(false);
  });

  it('builds a TLS config for Supabase direct connections', () => {
    expect(
      buildPgSslConfig({
        SUPABASE_DB_SSL: true,
        SUPABASE_DB_TLS_REJECT_UNAUTHORIZED: false,
        SUPABASE_DB_CA_CERT: 'certificate'
      })
    ).toEqual({
      rejectUnauthorized: false,
      ca: 'certificate'
    });
  });
});
