import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { DrizzleAdminAuditRepository } from '../src/modules/admin-audit/infrastructure/drizzle-admin-audit.repository';
import { DrizzleAdminRepository } from '../src/modules/admin/infrastructure/drizzle-admin.repository';
import { DrizzleApplicationsRepository } from '../src/modules/applications/drizzle-applications.repository';
import { DrizzleBrandsRepository } from '../src/modules/brands/drizzle-brands.repository';
import { DrizzleCartRepository } from '../src/modules/cart/infrastructure/drizzle-cart.repository';
import { DrizzleProductCatalogReader } from '../src/modules/cart/infrastructure/drizzle-product-catalog.reader';
import { DrizzleCommissionRepository, DrizzleCommissionRuleResolver } from '../src/modules/commissions/infrastructure/drizzle-commissions.repository';
import { DrizzleCreatorsRepository } from '../src/modules/creators/drizzle-creators.repository';
import { DrizzleEditorialRepository } from '../src/modules/editorial/infrastructure/drizzle-editorial.repository';
import { DrizzleIdentityRepository } from '../src/modules/identity/infrastructure/persistence/drizzle-identity.repository';
import {
  DrizzleOrderRepository,
  DrizzleProductSnapshotReader,
} from '../src/modules/orders/infrastructure/drizzle-orders.repository';
import {DrizzleOrderCancellationRepository} from '../src/modules/orders/infrastructure/drizzle-order-cancellation.repository';
import { DrizzleOutfitRepository } from '../src/modules/outfits/infrastructure/drizzle-outfit.repository';
import {DrizzleStripePaymentFinalizer} from '../src/modules/payments/infrastructure/drizzle-stripe-payment-finalizer';
import { DrizzleProductRepository } from '../src/modules/products/infrastructure/drizzle-product.repository';
import { DrizzleSavedRepository } from '../src/modules/saved/infrastructure/drizzle-saved.repository';
import { DrizzleShipmentRepository } from '../src/modules/shipping/infrastructure/drizzle-shipping.repository';
import { DrizzleWorkspacesRepository } from '../src/modules/workspaces/infrastructure/drizzle-workspaces.repository';
import { DatabaseService } from '../src/shared/infrastructure/database/database.service';

const databaseBackedProviders = [
  DrizzleAdminAuditRepository,
  DrizzleAdminRepository,
  DrizzleApplicationsRepository,
  DrizzleBrandsRepository,
  DrizzleCartRepository,
  DrizzleProductCatalogReader,
  DrizzleCommissionRepository,
  DrizzleCommissionRuleResolver,
  DrizzleCreatorsRepository,
  DrizzleEditorialRepository,
  DrizzleIdentityRepository,
  DrizzleOrderRepository,
  DrizzleProductSnapshotReader,
  DrizzleOrderCancellationRepository,
  DrizzleOutfitRepository,
  DrizzleStripePaymentFinalizer,
  DrizzleProductRepository,
  DrizzleSavedRepository,
  DrizzleShipmentRepository,
  DrizzleWorkspacesRepository
] as const;

describe('Nest dependency injection metadata regressions', () => {
  it('injects DatabaseService into Drizzle providers in the dev transpiler path', async () => {
    const database = { db: {} };
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: DatabaseService, useValue: database },
        ...databaseBackedProviders
      ]
    }).compile();

    for (const provider of databaseBackedProviders) {
      const instance = moduleRef.get(provider);
      expect(Reflect.get(instance, 'database')).toBe(database);
    }
  });
});
