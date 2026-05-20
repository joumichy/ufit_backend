import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdentityService } from '../src/modules/identity/application/identity.service';
import type { AuthenticatedUser } from '../src/modules/identity/domain/user.types';
import { AUTH_TOKEN_VERIFIER } from '../src/modules/identity/infrastructure/auth/auth-token-verifier';
import { DatabaseService } from '../src/shared/infrastructure/database/database.service';

const currentUser: AuthenticatedUser = {
  id: '59b6049d-cb0b-4dd2-a6e8-c5728ce8bddd',
  email: 'client@example.com',
  displayName: 'Client UFit',
  avatarUrl: null,
  status: 'active',
  roles: ['customer'],
  createdAt: new Date('2026-05-20T00:00:00.000Z'),
  updatedAt: new Date('2026-05-20T00:00:00.000Z')
};

describe('Identity endpoints', () => {
  let app: INestApplication | undefined;
  const identityService = {
    resolveCurrentUser: vi.fn(),
    updateProfile: vi.fn()
  };

  beforeEach(async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_DIRECT_CONNECTION_DB_URL', 'postgres://user:pass@localhost:5432/postgres');
    vi.stubEnv('NODE_ENV', 'test');

    identityService.resolveCurrentUser.mockResolvedValue(currentUser);
    identityService.updateProfile.mockResolvedValue({
      ...currentUser,
      displayName: 'Updated Client',
      avatarUrl: 'https://example.com/avatar.png',
      updatedAt: new Date('2026-05-20T01:00:00.000Z')
    });

    const { AppModule } = await import('../src/app.module');

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule]
    })
      .overrideProvider(DatabaseService)
      .useValue({
        checkHealth: vi.fn()
      })
      .overrideProvider(AUTH_TOKEN_VERIFIER)
      .useValue({
        verify: vi.fn().mockResolvedValue({
          sub: '2ac50e3e-7c11-43d6-bec1-0dcbef8d8997',
          email: 'client@example.com'
        })
      })
      .overrideProvider(IdentityService)
      .useValue(identityService)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true
      })
    );
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('returns the current user profile without internal Supabase ids', async () => {
    const response = await request(app?.getHttpServer()).get('/me').set('Authorization', 'Bearer test.jwt.token').expect(200);

    expect(response.body).toEqual({
      id: currentUser.id,
      email: 'client@example.com',
      displayName: 'Client UFit',
      avatarUrl: null,
      status: 'active',
      roles: ['customer'],
      createdAt: '2026-05-20T00:00:00.000Z',
      updatedAt: '2026-05-20T00:00:00.000Z'
    });
    expect(response.body.supabaseUserId).toBeUndefined();
  });

  it('rejects unauthenticated requests', async () => {
    await request(app?.getHttpServer()).get('/me').expect(401);
  });

  it('updates the current user profile', async () => {
    const response = await request(app?.getHttpServer())
      .patch('/me')
      .set('Authorization', 'Bearer test.jwt.token')
      .send({
        displayName: 'Updated Client',
        avatarUrl: 'https://example.com/avatar.png'
      })
      .expect(200);

    expect(identityService.updateProfile).toHaveBeenCalledWith(currentUser.id, {
      displayName: 'Updated Client',
      avatarUrl: 'https://example.com/avatar.png'
    });
    expect(response.body.displayName).toBe('Updated Client');
  });

  it('validates profile update payloads', async () => {
    await request(app?.getHttpServer())
      .patch('/me')
      .set('Authorization', 'Bearer test.jwt.token')
      .send({
        role: 'admin'
      })
      .expect(400);
  });
});
