import type {WorkspaceSales, WorkspaceCommissionCurrency, WorkspaceCommission} from '../domain/workspace-finance';
import {WORKSPACE_FINANCE} from '../domain/workspace-finance';
import {canAuthorProfile, PROFILE_STATUS, type ProfileOwner} from '../../../shared/domain/profile-editing.contract';
import {PUBLIC_PROFILE} from '../../../shared/domain/public-profile.contract';
import type {IdentityAccess} from '../../identity/domain/user.types';
import { z } from 'zod';
import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';

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
  commissions: WorkspaceCommissionCurrency[];
  sales: WorkspaceSales;
}

export interface BrandWorkspaceMetrics {
  products: Record<'total' | 'draft' | 'underReview' | 'active' | 'rejected' | 'archived', number>;
  orders: Record<'paid' | 'preparing' | 'shipped' | 'delivered' | 'cancelled' | 'refunded', number>;
  sales: WorkspaceSales;
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

export type CreatorWorkspaceCommission = WorkspaceCommission;

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

export const WORKSPACE_MEMBERSHIP = {
  defaultLimit: 20,
  maximumLimit: 50,
  minimumLimit: 1,
  overflow: 1,
  lastIndex: -1,
  invalid: "Invalid workspace membership page",
} as const;
const membershipPage = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(WORKSPACE_MEMBERSHIP.minimumLimit)
      .max(WORKSPACE_MEMBERSHIP.maximumLimit)
      .default(WORKSPACE_MEMBERSHIP.defaultLimit),
    cursor: z.uuid().optional(),
  })
  .strict();
export interface WorkspaceMemberships {
  nextCursor: string | null;
  creator: Pick<
    CreatorWorkspaceProfile,
    "id" | "displayName" | "status"
  > | null;
  brands: BrandWorkspaceProfile[];
}
export interface WorkspacesRepository {
  snapshot<T>(operation: (repository: WorkspacesRepository) => Promise<T>): Promise<T>;
  actorAccess(userId: string): Promise<IdentityAccess | undefined>;
  listBrandsForUser(
    userId: string,
    limit: number,
    cursor?: string,
  ): Promise<{ items: BrandWorkspaceProfile[]; nextCursor: string | null }>;

  findCreatorProfileByUserId(userId: string): Promise<CreatorWorkspaceProfile | null>;
  getCreatorMetrics(creatorId: string): Promise<CreatorWorkspaceMetrics>;
  listCreatorOutfits(creatorId: string, page: Required<WorkspacePageInput>): Promise<WorkspacePage<CreatorWorkspaceOutfit>>;
  listCreatorCommissions(creatorId: string, page: Required<WorkspacePageInput>): Promise<WorkspacePage<CreatorWorkspaceCommission>>;

  findBrandProfileForMember(brandProfileId: string, userId: string): Promise<BrandWorkspaceProfile | null>;
  getBrandMetrics(brandProfileId: string): Promise<BrandWorkspaceMetrics>;
  listBrandProducts(brandProfileId: string, page: Required<WorkspacePageInput>): Promise<WorkspacePage<BrandWorkspaceProduct>>;
  listBrandOutfitIntegrations(
    brandProfileId: string,
    page: Required<WorkspacePageInput>
  ): Promise<WorkspacePage<BrandWorkspaceOutfitIntegration>>;
}

const WORKSPACE_ACCESS_MESSAGE = {
  creatorMissing: 'Creator profile not found',
  creatorSuspended: 'Suspended creators cannot access the creator workspace',
  brandMembership: 'Brand membership is required',
  brandSuspended: 'Suspended brands cannot access the brand workspace',
} as const;

@Injectable()
export class WorkspacesService {
  constructor(@Inject(WORKSPACES_REPOSITORY) private readonly workspaces: WorkspacesRepository) {}

  async listForUser(
    userId: string,
    raw: unknown = {},
  ): Promise<WorkspaceMemberships> {
    const parsed = membershipPage.safeParse(raw);
    if (!parsed.success)
      throw new BadRequestException(WORKSPACE_MEMBERSHIP.invalid);
    const [creator, brands] = await Promise.all([
      this.workspaces.findCreatorProfileByUserId(userId),
      this.workspaces.listBrandsForUser(
        userId,
        parsed.data.limit,
        parsed.data.cursor,
      ),
    ]);
    return {
      creator: creator
        ? {
            id: creator.id,
            displayName: creator.displayName,
            status: creator.status,
          }
        : null,
      brands: brands.items,
      nextCursor: brands.nextCursor,
    };
  }
  async getCreatorDashboard(userId: string) {
    return this.workspaces.snapshot(async repository => {
      const profile = await this.requireCreatorProfile(userId, repository);
      await this.requireFinancialAccess(repository, userId, {creatorId: profile.id, brandId: null});
      return {profile, performance: await repository.getCreatorMetrics(profile.id)};
    });
  }

  async listCreatorOutfits(userId: string, input: WorkspacePageInput) {
    const profile = await this.requireCreatorProfile(userId);
    return this.workspaces.listCreatorOutfits(profile.id, this.normalizePage(input));
  }

  async listCreatorCommissions(userId: string, input: WorkspacePageInput) {
    return this.workspaces.snapshot(async repository => {
      const profile = await this.requireCreatorProfile(userId, repository);
      await this.requireFinancialAccess(repository, userId, {creatorId: profile.id, brandId: null});
      return repository.listCreatorCommissions(profile.id, this.normalizePage(input));
    });
  }

  async getBrandDashboard(brandProfileId: string, userId: string) {
    return this.workspaces.snapshot(async repository => {
      const profile = await this.requireBrandMember(brandProfileId, userId, repository);
      await this.requireFinancialAccess(repository, userId, {creatorId: null, brandId: profile.id});
      return {profile, performance: await repository.getBrandMetrics(profile.id)};
    });
  }

  async listBrandProducts(brandProfileId: string, userId: string, input: WorkspacePageInput) {
    const profile = await this.requireBrandMember(brandProfileId, userId);
    return this.workspaces.listBrandProducts(profile.id, this.normalizePage(input));
  }

  async listBrandOutfitIntegrations(brandProfileId: string, userId: string, input: WorkspacePageInput) {
    const profile = await this.requireBrandMember(brandProfileId, userId);
    return this.workspaces.listBrandOutfitIntegrations(profile.id, this.normalizePage(input));
  }

  private async requireCreatorProfile(userId: string, repository = this.workspaces): Promise<CreatorWorkspaceProfile> {
    const profile = await repository.findCreatorProfileByUserId(userId);
    if (!profile) {
      throw new NotFoundException(WORKSPACE_ACCESS_MESSAGE.creatorMissing);
    }
    if (profile.status === PROFILE_STATUS.suspended) {
      throw new ForbiddenException(WORKSPACE_ACCESS_MESSAGE.creatorSuspended);
    }
    return profile;
  }

  private async requireBrandMember(brandProfileId: string, userId: string, repository = this.workspaces): Promise<BrandWorkspaceProfile> {
    const profile = await repository.findBrandProfileForMember(brandProfileId, userId);
    if (!profile) {
      throw new ForbiddenException(WORKSPACE_ACCESS_MESSAGE.brandMembership);
    }
    if (profile.status === PROFILE_STATUS.suspended) {
      throw new ForbiddenException(WORKSPACE_ACCESS_MESSAGE.brandSuspended);
    }
    return profile;
  }

  private async requireFinancialAccess(repository: WorkspacesRepository, userId: string, owner: ProfileOwner) {
    const actor = await repository.actorAccess(userId);
    if (!actor || actor.status !== PUBLIC_PROFILE.userStatus || !canAuthorProfile(actor.roles, owner)) {
      throw new ForbiddenException(WORKSPACE_FINANCE.failure.access);
    }
  }

  private normalizePage(input: WorkspacePageInput): Required<WorkspacePageInput> {
    const rawLimit = input.limit ?? 20;
    const rawOffset = input.offset ?? 0;
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : 20, 1), 50);
    const offset = Math.max(Number.isFinite(rawOffset) ? Math.trunc(rawOffset) : 0, 0);
    return { limit, offset };
  }
}
