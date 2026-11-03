import type {IdentityAccess} from '../../src/modules/identity/domain/user.types';
import {WORKSPACE_FINANCE} from '../../src/modules/workspaces/domain/workspace-finance';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  WorkspacesService,
  type BrandWorkspaceMetrics,
  type BrandWorkspaceProduct,
  type BrandWorkspaceOutfitIntegration,
  type CreatorWorkspaceOutfit,
  type BrandWorkspaceProfile,
  type CreatorWorkspaceMetrics,
  type CreatorWorkspaceProfile,
  type WorkspacePage,
  type WorkspacePageInput,
  type WorkspacesRepository
} from '../../src/modules/workspaces/application/workspaces.service';

const creatorProfile: CreatorWorkspaceProfile = {
  id: 'creator-1',
  userId: 'user-1',
  displayName: 'Creator One',
  slug: 'creator-one',
  status: 'active',
  grade: {
    code: 'seed',
    label: 'Seed',
    rank: 1
  }
};

const creatorMetrics: CreatorWorkspaceMetrics = {
  outfits: {
    total: 3,
    draft: 1,
    scheduled: 1,
    published: 1,
    archived: 0
  },
  commissions: [{currency: 'CHF', originalAmount: 2000, adjustedAmount: 300, netAmount: 1700,
    estimatedAmount: 0, pendingAmount: 1000, validatedAmount: 400, paidAmount: 300, paidAdjustmentAmount: 0,
    estimatedCount: 0, pendingCount: 2, validatedCount: 1, paidCount: 1, cancelledCount: 0}],
  sales: {basis: WORKSPACE_FINANCE.basis.attributedMerchandise,
    currencies: [{currency: 'CHF', capturedOrderCount: 4, capturedAmount: 20000, refundedAmount: 3000, refundInProgressAmount: 500, netAmount: 17000}]}
};

const brandProfile: BrandWorkspaceProfile = {
  id: 'brand-1',
  brandName: 'Brand One',
  slug: 'brand-one',
  status: 'active',
  memberRole: 'owner'
};

const brandMetrics: BrandWorkspaceMetrics = {
  products: {
    total: 5,
    draft: 2,
    active: 3,
    archived: 0
  },
  orders: {
    paid: 2,
    preparing: 1,
    shipped: 0,
    delivered: 1,
    cancelled: 0,
    refunded: 0
  },
  sales: {basis: WORKSPACE_FINANCE.basis.orderTotal,
    currencies: [{currency: 'CHF', capturedOrderCount: 4, capturedAmount: 42000, refundedAmount: 2000, refundInProgressAmount: 0, netAmount: 40000}]},
  stock: {
    lowStockVariants: 2
  }
};

class FakeWorkspacesRepository implements WorkspacesRepository {
  async getRevenue(): Promise<never> { throw new Error('Revenue projection not configured in this test'); }
  actor: IdentityAccess | undefined = {status: 'active', roles: ['creator', 'brand_owner']};
  inSnapshot = false;
  async snapshot<T>(operation: (repository: WorkspacesRepository) => Promise<T>): Promise<T> {
    this.inSnapshot = true;
    try { return await operation(this); } finally { this.inSnapshot = false; }
  }
  async actorAccess() { expect(this.inSnapshot).toBe(true); return this.actor; }
  async listBrandsForUser(): Promise<{items: BrandWorkspaceProfile[]; nextCursor: string | null}> {
    return {items: [brandProfile], nextCursor: null};
  }
  creator: CreatorWorkspaceProfile | null = creatorProfile;
  brand: BrandWorkspaceProfile | null = brandProfile;
  lastPage: Required<WorkspacePageInput> | undefined;

  async findCreatorProfileByUserId(): Promise<CreatorWorkspaceProfile | null> {
    return this.creator ? structuredClone(this.creator) : null;
  }

  async getCreatorMetrics(): Promise<CreatorWorkspaceMetrics> {
    return structuredClone(creatorMetrics);
  }

  async listCreatorOutfits(_creatorId: string, page: Required<WorkspacePageInput>) {
    this.lastPage = page;
    return emptyPage<CreatorWorkspaceOutfit>(page);
  }

  async findBrandProfileForMember(): Promise<BrandWorkspaceProfile | null> {
    return this.brand ? structuredClone(this.brand) : null;
  }

  async getBrandMetrics(): Promise<BrandWorkspaceMetrics> {
    return structuredClone(brandMetrics);
  }

  async listBrandProducts(_brandProfileId: string, page: Required<WorkspacePageInput>) {
    this.lastPage = page;
    return emptyPage<BrandWorkspaceProduct>(page);
  }

  async listBrandOutfitIntegrations(_brandProfileId: string, page: Required<WorkspacePageInput>) {
    this.lastPage = page;
    return emptyPage<BrandWorkspaceOutfitIntegration>(page);
  }
}

function emptyPage<T>(page: Required<WorkspacePageInput>): WorkspacePage<T> {
  return {
    items: [],
    page: {
      ...page,
      total: 0,
      nextOffset: null
    }
  };
}

describe('WorkspacesService', () => {
  it('returns creator dashboard projections with grade and performance', async () => {
    const service = new WorkspacesService(new FakeWorkspacesRepository());

    await expect(service.getCreatorDashboard('user-1')).resolves.toEqual({
      profile: creatorProfile,
      performance: creatorMetrics
    });
  });

  it('rejects creator workspace access without a creator profile', async () => {
    const repository = new FakeWorkspacesRepository();
    repository.creator = null;
    const service = new WorkspacesService(repository);

    await expect(service.getCreatorDashboard('user-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects suspended creators from creator workspace projections', async () => {
    const repository = new FakeWorkspacesRepository();
    repository.creator = { ...creatorProfile, status: 'suspended' };
    const service = new WorkspacesService(repository);

    await expect(service.listCreatorOutfits('user-1', {})).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns brand dashboard projections only after membership scope is verified', async () => {
    const service = new WorkspacesService(new FakeWorkspacesRepository());

    await expect(service.getBrandDashboard('brand-1', 'user-1')).resolves.toEqual({
      profile: brandProfile,
      performance: brandMetrics
    });
  });

  it('rejects brand workspace access without active membership', async () => {
    const repository = new FakeWorkspacesRepository();
    repository.brand = null;
    const service = new WorkspacesService(repository);

    await expect(service.getBrandDashboard('brand-1', 'user-1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it.each([undefined, {status: 'suspended', roles: ['creator', 'brand_owner']},
    {status: 'active', roles: ['customer']}])('rejects financial reads after current identity access changed: %j', async actor => {
    const repository = new FakeWorkspacesRepository();
    repository.actor = actor as IdentityAccess | undefined;
    const service = new WorkspacesService(repository);
    await expect(service.getCreatorDashboard('user-1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.getBrandDashboard('brand-1', 'user-1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('normalizes pagination for workspace lists', async () => {
    const repository = new FakeWorkspacesRepository();
    const service = new WorkspacesService(repository);

    await service.listBrandProducts('brand-1', 'user-1', { limit: 999, offset: -5 });

    expect(repository.lastPage).toEqual({ limit: 50, offset: 0 });
  });
});
