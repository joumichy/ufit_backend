import type { ConnectionOptions } from 'node:tls';
import type { AppEnv } from '../../../config/env';

export type PgSslConfig = boolean | ConnectionOptions | undefined;

export function buildPgSslConfig(env: Pick<AppEnv, 'SUPABASE_DB_SSL' | 'SUPABASE_DB_TLS_REJECT_UNAUTHORIZED' | 'SUPABASE_DB_CA_CERT'>): PgSslConfig {
  if (!env.SUPABASE_DB_SSL) {
    return false;
  }

  const sslConfig: ConnectionOptions = {
    rejectUnauthorized: env.SUPABASE_DB_TLS_REJECT_UNAUTHORIZED
  };

  if (env.SUPABASE_DB_CA_CERT) {
    sslConfig.ca = env.SUPABASE_DB_CA_CERT;
  }

  return sslConfig;
}
