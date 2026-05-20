import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { getEnv } from '../../../config/env';
import { buildPgSslConfig } from './pg-ssl';
import { quoteIdentifier } from './quote-identifier';

interface MigrationFile {
  id: string;
  sql: string;
  checksum: string;
}

async function readMigrations(): Promise<MigrationFile[]> {
  const migrationsDir = resolve(__dirname, 'migrations');
  const filenames = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();

  return Promise.all(
    filenames.map(async (filename) => {
      const sql = await readFile(resolve(migrationsDir, filename), 'utf8');
      return {
        id: filename,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex')
      };
    })
  );
}

async function ensureMigrationTable(client: PoolClient, schemaName: string): Promise<void> {
  const schema = quoteIdentifier(schemaName);
  await client.query(`create schema if not exists ${schema}`);
  await client.query(`
    create table if not exists ${schema}."schema_migrations" (
      "id" text primary key,
      "checksum" text not null,
      "executed_at" timestamptz not null default now()
    )
  `);
}

async function runMigration(client: PoolClient, schemaName: string, migration: MigrationFile): Promise<'applied' | 'skipped'> {
  const schema = quoteIdentifier(schemaName);

  await client.query('begin');
  try {
    const existing = await client.query<{ checksum: string }>(
      `select checksum from ${schema}."schema_migrations" where id = $1`,
      [migration.id]
    );

    if (existing.rows[0]) {
      if (existing.rows[0].checksum !== migration.checksum) {
        throw new Error(`Migration checksum mismatch for ${migration.id}`);
      }

      await client.query('commit');
      return 'skipped';
    }

    await client.query(migration.sql);
    await client.query(`insert into ${schema}."schema_migrations" (id, checksum) values ($1, $2)`, [
      migration.id,
      migration.checksum
    ]);
    await client.query('commit');
    return 'applied';
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

export async function migrateDatabase(): Promise<void> {
  const env = getEnv();
  const pool = new Pool({
    connectionString: env.SUPABASE_DIRECT_CONNECTION_DB_URL,
    ssl: buildPgSslConfig(env),
    max: 1,
    connectionTimeoutMillis: 10_000
  });

  const client = await pool.connect();
  try {
    await ensureMigrationTable(client, env.UFIT_DB_SCHEMA);
    const migrations = await readMigrations();

    for (const migration of migrations) {
      const status = await runMigration(client, env.UFIT_DB_SCHEMA, migration);
      console.log(`${status}: ${migration.id}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  migrateDatabase().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
