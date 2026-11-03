import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Includes cold transformation and import of the complete backend before startup.
const HEALTH_BOOTSTRAP_TIMEOUT_MS = 15_000;

describe('GET /health', () => {
  let app: INestApplication | undefined;

  beforeEach(() => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_DIRECT_CONNECTION_DB_URL', 'postgres://user:pass@localhost:5432/postgres');
  });

  afterEach(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('returns backend and database health without exposing secrets', async () => {
    const { AppModule } = await import('../src/app.module');
    const { DatabaseService } = await import('../src/shared/infrastructure/database/database.service');

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule]
    })
      .overrideProvider(DatabaseService)
      .useValue({
        checkHealth: () =>
          Promise.resolve({
            connected: true,
            schema: 'ufit',
            schemaExists: true,
            checkedAt: '2026-05-20T00:00:00.000Z'
          })
      })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    const response = await request(app.getHttpServer()).get('/health').expect(200);

    expect(response.body).toEqual({
      status: 'ok',
      service: 'ufit-backend',
      environment: 'test',
      database: {
        connected: true,
        schema: 'ufit',
        schemaExists: true,
        checkedAt: '2026-05-20T00:00:00.000Z'
      }
    });
    expect(JSON.stringify(response.body)).not.toContain('postgres://');
  }, HEALTH_BOOTSTRAP_TIMEOUT_MS);
});
