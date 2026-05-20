import { Pool } from 'pg';
import { getEnv } from '../src/config/env';
import { buildPgSslConfig } from '../src/shared/infrastructure/database/pg-ssl';
import { quoteIdentifier } from '../src/shared/infrastructure/database/quote-identifier';

async function verifyDatabase(): Promise<void> {
  const env = getEnv();
  const schema = quoteIdentifier(env.UFIT_DB_SCHEMA);
  const pool = new Pool({
    connectionString: env.SUPABASE_DIRECT_CONNECTION_DB_URL,
    ssl: buildPgSslConfig(env),
    max: 1,
    connectionTimeoutMillis: 10_000
  });

  try {
    const schemaResult = await pool.query<{ schema_exists: boolean }>(
      'select exists(select 1 from information_schema.schemata where schema_name = $1) as schema_exists',
      [env.UFIT_DB_SCHEMA]
    );

    const migrationsResult = await pool.query<{ count: string }>(
      `select count(*)::text as count from ${schema}."schema_migrations"`
    );

    console.log(`schema:${env.UFIT_DB_SCHEMA}:exists=${schemaResult.rows[0]?.schema_exists === true}`);
    console.log(`schema_migrations:count=${migrationsResult.rows[0]?.count ?? '0'}`);
  } finally {
    await pool.end();
  }
}

verifyDatabase().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
