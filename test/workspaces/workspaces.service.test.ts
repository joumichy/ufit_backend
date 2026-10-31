import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  WorkspacesService,
  type BrandWorkspaceMetrics,
  type BrandWorkspaceProduct,
  type BrandWorkspaceOrder,
  type BrandWorkspaceOutfitIntegration,
  type CreatorWorkspaceOutfit,
  type CreatorWorkspaceCommission,
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
    rank: 1,
    commissionBps: 800
  }
};

const creatorMetrics: CreatorWorkspaceMetrics = {
  outfits: {
    total: 3,
    draft: 1,
    underReview: 1,
    published: 1,
    rejected: 0
  },
  commissions: {
    pendingAmount: 1200,
    validatedAmount: 500,
    paidAmount: 300,
    totalAmount: 2000,
    pendingCount: 2,
    validatedCount: 1,
    paidCount: 1
  },
  sales: {
    paidOrderCount: 4,
    grossAmount: 20000,
    currency: 'CHF'
  }
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
    draft: 1,
    underReview: 1,
    active: 3,
    rejected: 0,
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
  sales: {
    paidOrderCount: 4,
    grossAmount: 42000,
    currency: 'CHF'
  },
  stock: {
    lowStockVariants: 2
  }
};

class FakeWorkspacesRepository implements WorkspacesRepository {
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

  async listCreatorCommissions(_creatorId: string, page: Required<WorkspacePageInput>) {
    this.lastPage = page;
    return emptyPage<CreatorWorkspaceCommission>(page);
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

  async listBrandOrders(_brandProfileId: string, page: Required<WorkspacePageInput>) {
    this.lastPage = page;
    return emptyPage<BrandWorkspaceOrder>(page);
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

    await expect(service.listBrandOrders('brand-1', 'user-1', {})).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('normalizes pagination for workspace lists', async () => {
    const repository = new FakeWorkspacesRepository();
    const service = new WorkspacesService(repository);

    await service.listBrandProducts('brand-1', 'user-1', { limit: 999, offset: -5 });

    expect(repository.lastPage).toEqual({ limit: 50, offset: 0 });
  });
});
