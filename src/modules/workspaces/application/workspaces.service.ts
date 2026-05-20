import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';

export const WORKSPACES_REPOSITORY = Symbol('WORKSPACES_REPOSITORY');

export interface WorkspacePageInput {
  limit?: number;
  offset?: number;
}

export interface WorkspacePage<T> {
  items: T[];
  page: {
    limit: number;
    offset: number;
    total: number;
    nextOffset: number | null;
  };
}

export interface CreatorWorkspaceProfile {
  id: string;
  userId: string;
  displayName: string;
  slug: string;
  status: string;
  grade: {
    code: string;
    label: string;
    rank: number;
    commissionBps: number;
  };
}

export interface BrandWorkspaceProfile {
  id: string;
  brandName: string;
  slug: string;
  status: string;
  memberRole: 'owner' | 'manager';
}

export interface CreatorWorkspaceMetrics {
  outfits: Record<'total' | 'draft' | 'underReview' | 'published' | 'rejected', number>;
  commissions: {
    pendingAmount: number;
    validatedAmount: number;
    paidAmount: number;
    totalAmount: number;
    pendingCount: number;
    validatedCount: number;
    paidCount: number;
  };
  sales: {
    paidOrderCount: number;
    grossAmount: number;
    currency: string;
  };
}

export interface BrandWorkspaceMetrics {
  products: Record<'total' | 'draft' | 'underReview' | 'active' | 'rejected' | 'archived', number>;
  orders: Record<'paid' | 'preparing' | 'shipped' | 'delivered' | 'cancelled' | 'refunded', number>;
  sales: {
    paidOrderCount: number;
    grossAmount: number;
    currency: string;
  };
  stock: {
    lowStockVariants: number;
  };
}

export interface CreatorWorkspaceOutfit {
  id: string;
  title: string;
  status: string;
  visibility: string;
  totalPriceMin: number;
  totalPriceMax: number;
  publishedAt: string | null;
  updatedAt: string | null;
}

export interface CreatorWorkspaceCommission {
  id: string;
  orderItemId: string;
  brandId: string;
  sourceOutfitId: string;
  status: string;
  baseAmount: number;
  commissionRate: number;
  commissionAmount: number;
  createdAt: string | null;
}

export interface BrandWorkspaceProduct {
  id: string;
  name: string;
  status: string;
  category: string;
  basePrice: number;
  currency: string;
  totalStock: number;
  activeVariants: number;
  updatedAt: string | null;
}

export interface BrandWorkspaceOrder {
  id: string;
  orderNumber: string;
  status: string;
  totalAmount: number;
  currency: string;
  sourceCreatorId: string | null;
  sourceOutfitId: string | null;
  createdAt: string | null;
}

export interface BrandWorkspaceOutfitIntegration {
  outfitId: string;
  title: string;
  status: string;
  visibility: string;
  creatorId: string | null;
  productCount: number;
  totalPriceMax: number;
  publishedAt: string | null;
  updatedAt: string | null;
}

export interface WorkspacesRepository {
  findCreatorProfileByUserId(userId: string): Promise<CreatorWorkspaceProfile | null>;
  getCreatorMetrics(creatorId: string): Promise<CreatorWorkspaceMetrics>;
  listCreatorOutfits(creatorId: string, page: Required<WorkspacePageInput>): Promise<WorkspacePage<CreatorWorkspaceOutfit>>;
  listCreatorCommissions(creatorId: string, page: Required<WorkspacePageInput>): Promise<WorkspacePage<CreatorWorkspaceCommission>>;

  findBrandProfileForMember(brandProfileId: string, userId: string): Promise<BrandWorkspaceProfile | null>;
  getBrandMetrics(brandProfileId: string): Promise<BrandWorkspaceMetrics>;
  listBrandProducts(brandProfileId: string, page: Required<WorkspacePageInput>): Promise<WorkspacePage<BrandWorkspaceProduct>>;
  listBrandOrders(brandProfileId: string, page: Required<WorkspacePageInput>): Promise<WorkspacePage<BrandWorkspaceOrder>>;
  listBrandOutfitIntegrations(
    brandProfileId: string,
    page: Required<WorkspacePageInput>
  ): Promise<WorkspacePage<BrandWorkspaceOutfitIntegration>>;
}

@Injectable()
export class WorkspacesService {
  constructor(@Inject(WORKSPACES_REPOSITORY) private readonly workspaces: WorkspacesRepository) {}

  async getCreatorDashboard(userId: string) {
    const profile = await this.requireActiveCreator(userId);
    return {
      profile,
      performance: await this.workspaces.getCreatorMetrics(profile.id)
    };
  }

  async listCreatorOutfits(userId: string, input: WorkspacePageInput) {
    const profile = await this.requireActiveCreator(userId);
    return this.workspaces.listCreatorOutfits(profile.id, this.normalizePage(input));
  }

  async listCreatorCommissions(userId: string, input: WorkspacePageInput) {
    const profile = await this.requireActiveCreator(userId);
    return this.workspaces.listCreatorCommissions(profile.id, this.normalizePage(input));
  }

  async getBrandDashboard(brandProfileId: string, userId: string) {
    const profile = await this.requireBrandMember(brandProfileId, userId);
    return {
      profile,
      performance: await this.workspaces.getBrandMetrics(profile.id)
    };
  }

  async listBrandProducts(brandProfileId: string, userId: string, input: WorkspacePageInput) {
    const profile = await this.requireBrandMember(brandProfileId, userId);
    return this.workspaces.listBrandProducts(profile.id, this.normalizePage(input));
  }

  async listBrandOrders(brandProfileId: string, userId: string, input: WorkspacePageInput) {
    const profile = await this.requireBrandMember(brandProfileId, userId);
    return this.workspaces.listBrandOrders(profile.id, this.normalizePage(input));
  }

  async listBrandOutfitIntegrations(brandProfileId: string, userId: string, input: WorkspacePageInput) {
    const profile = await this.requireBrandMember(brandProfileId, userId);
    return this.workspaces.listBrandOutfitIntegrations(profile.id, this.normalizePage(input));
  }

  private async requireActiveCreator(userId: string): Promise<CreatorWorkspaceProfile> {
    const profile = await this.workspaces.findCreatorProfileByUserId(userId);
    if (!profile) {
      throw new NotFoundException('Creator profile not found');
    }
    if (profile.status === 'suspended') {
      throw new ForbiddenException('Suspended creators cannot access the creator workspace');
    }
    return profile;
  }

  private async requireBrandMember(brandProfileId: string, userId: string): Promise<BrandWorkspaceProfile> {
    const profile = await this.workspaces.findBrandProfileForMember(brandProfileId, userId);
    if (!profile) {
      throw new ForbiddenException('Brand membership is required');
    }
    if (profile.status === 'suspended') {
      throw new ForbiddenException('Suspended brands cannot access the brand workspace');
    }
    return profile;
  }

  private normalizePage(input: WorkspacePageInput): Required<WorkspacePageInput> {
    const rawLimit = input.limit ?? 20;
    const rawOffset = input.offset ?? 0;
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : 20, 1), 50);
    const offset = Math.max(Number.isFinite(rawOffset) ? Math.trunc(rawOffset) : 0, 0);
    return { limit, offset };
  }
}
