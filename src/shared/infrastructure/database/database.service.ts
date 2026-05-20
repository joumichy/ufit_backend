import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { QueryResult, QueryResultRow } from 'pg';
import { getEnv } from '../../../config/env';
import { buildPgSslConfig } from './pg-ssl';
import * as schema from './schema';

export interface DatabaseHealth {
  connected: boolean;
  schema: string;
  schemaExists: boolean;
  checkedAt: string;
}

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly env = getEnv();
  private readonly pool = new Pool({
    connectionString: this.env.SUPABASE_DIRECT_CONNECTION_DB_URL,
    ssl: buildPgSslConfig(this.env),
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000
  });

  readonly db: NodePgDatabase<typeof schema> = drizzle(this.pool, { schema });

  async query<T extends QueryResultRow = QueryResultRow>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
    return this.pool.query<T>(sql, [...params]);
  }

  async checkHealth(): Promise<DatabaseHealth> {
    const result = await this.pool.query<{ schema_exists: boolean; checked_at: Date }>(
      `select exists(select 1 from information_schema.schemata where schema_name = $1) as schema_exists, now() as checked_at`,
      [this.env.UFIT_DB_SCHEMA]
    );

    const row = result.rows[0];
    return {
      connected: true,
      schema: this.env.UFIT_DB_SCHEMA,
      schemaExists: row?.schema_exists ?? false,
      checkedAt: (row?.checked_at ?? new Date()).toISOString()
    };
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
    this.logger.log('PostgreSQL pool closed');
  }
}
