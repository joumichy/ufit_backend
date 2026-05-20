import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminAuditService } from '../src/modules/admin-audit/application/admin-audit.service';
import { AdminService } from '../src/modules/admin/application/admin.service';
import { IdentityService } from '../src/modules/identity/application/identity.service';
import type { AuthenticatedUser } from '../src/modules/identity/domain/user.types';
import { AUTH_TOKEN_VERIFIER } from '../src/modules/identity/infrastructure/auth/auth-token-verifier';
import { ProductsService } from '../src/modules/products/application/products.service';
import { PRODUCT_REPOSITORY } from '../src/modules/products/domain/product.types';
import { DatabaseService } from '../src/shared/infrastructure/database/database.service';

const baseUser: AuthenticatedUser = {
  id: '59b6049d-cb0b-4dd2-a6e8-c5728ce8bddd',
  email: 'client@example.com',
  displayName: 'Client UFit',
  avatarUrl: null,
  status: 'active',
  roles: ['customer'],
  createdAt: new Date('2026-05-20T00:00:00.000Z'),
  updatedAt: new Date('2026-05-20T00:00:00.000Z')
};

describe('security regressions', () => {
  let app: INestApplication | undefined;
  const identityService = {
    resolveCurrentUser: vi.fn()
  };
  const adminAuditService = {
    record: vi.fn()
  };
  const adminService = {
    getSummary: vi.fn(),
    listQueue: vi.fn()
  };
  const productsService = {
    reviewProduct: vi.fn()
  };

  beforeEach(async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_DIRECT_CONNECTION_DB_URL', 'postgres://user:pass@localhost:5432/postgres');
    vi.stubEnv('NODE_ENV', 'test');

    identityService.resolveCurrentUser.mockResolvedValue(baseUser);
    adminAuditService.record.mockImplementation((input) =>
      Promise.resolve({
        id: 'audit-1',
        createdAt: '2026-05-20T00:00:00.000Z',
        ...input
      })
    );
    adminService.getSummary.mockResolvedValue({
      queues: { applications: 0, products: 0, outfits: 0, orders: 0, commissions: 0 }
    });
    productsService.reviewProduct.mockResolvedValue({
      product: {
        id: '33333333-3333-4333-8333-333333333333',
        brandId: '44444444-4444-4444-8444-444444444444',
        name: 'Jacket',
        slug: 'jacket',
        description: 'A jacket',
        category: 'outerwear',
        genderTarget: null,
        status: 'active',
        basePrice: 12000,
        currency: 'CHF',
        material: null,
        careInstructions: null
      },
      variants: [],
      images: []
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
      .overrideProvider(AdminAuditService)
      .useValue(adminAuditService)
      .overrideProvider(AdminService)
      .useValue(adminService)
      .overrideProvider(ProductsService)
      .useValue(productsService)
      .overrideProvider(PRODUCT_REPOSITORY)
      .useValue({
        findById: vi.fn()
      })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('does not treat x-user-id as authentication', async () => {
    await request(app?.getHttpServer()).post('/cart/items').set('x-user-id', baseUser.id).send({}).expect(401);
  });

  it('rejects customer users from brand product moderation routes', async () => {
    await request(app?.getHttpServer())
      .post('/products')
      .set('Authorization', 'Bearer test.jwt.token')
      .send({})
      .expect(403);
  });

  it('rejects customer users from admin summaries', async () => {
    await request(app?.getHttpServer()).get('/admin/summaries').set('Authorization', 'Bearer test.jwt.token').expect(403);
    expect(adminService.getSummary).not.toHaveBeenCalled();
  });

  it('records admin audit actor from the authenticated user, not from headers', async () => {
    const adminUser: AuthenticatedUser = {
      ...baseUser,
      id: '11111111-1111-4111-8111-111111111111',
      roles: ['admin']
    };
    identityService.resolveCurrentUser.mockResolvedValue(adminUser);

    await request(app?.getHttpServer())
      .post('/admin/audit/actions')
      .set('Authorization', 'Bearer test.jwt.token')
      .set('x-user-id', '22222222-2222-4222-8222-222222222222')
      .send({
        action: 'product.reviewed',
        targetType: 'product',
        targetId: '33333333-3333-4333-8333-333333333333'
      })
      .expect(201);

    expect(adminAuditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        adminUserId: adminUser.id,
        action: 'product.reviewed',
        targetType: 'product'
      })
    );
  });

  it('audits product reviews with the authenticated admin actor', async () => {
    const adminUser: AuthenticatedUser = {
      ...baseUser,
      id: '11111111-1111-4111-8111-111111111111',
      roles: ['admin']
    };
    identityService.resolveCurrentUser.mockResolvedValue(adminUser);

    await request(app?.getHttpServer())
      .patch('/products/33333333-3333-4333-8333-333333333333/review')
      .set('Authorization', 'Bearer test.jwt.token')
      .send({
        decision: 'active',
        reviewerId: '22222222-2222-4222-8222-222222222222'
      })
      .expect(200);

    expect(productsService.reviewProduct).toHaveBeenCalledWith('33333333-3333-4333-8333-333333333333', {
      decision: 'active',
      reviewerId: adminUser.id
    });
    expect(adminAuditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        adminUserId: adminUser.id,
        action: 'product.reviewed',
        targetType: 'product',
        targetId: '33333333-3333-4333-8333-333333333333',
        payload: {
          decision: 'active',
          rejectionReason: null
        }
      })
    );
  });
});
