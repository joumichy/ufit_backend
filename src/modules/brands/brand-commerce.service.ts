import {BadRequestException, ConflictException, ForbiddenException, Inject, Injectable} from '@nestjs/common';
import {BRANDS_REPOSITORY} from './brands.tokens';
import type {BrandsRepository, BrandCommerceAccess} from './brands.repository';
import {BrandsService} from './brands.service';
import {BRAND_COMMERCE, brandCommercePolicySchema, COMMERCE_POLICY_KEY, updateBrandCommercePolicySchema,
  type BrandCommercePolicy, type BrandCommercePolicyDocument} from './commerce-policy';
import type {AuthenticatedUser} from '../identity/domain/user.types';
import {PROFILE_EDITING, canAuthorProfile} from '../../shared/domain/profile-editing.contract';
import {PUBLIC_PROFILE} from '../../shared/domain/public-profile.contract';

type Settings = Awaited<ReturnType<BrandsRepository['findSettings']>>;

@Injectable()
export class BrandCommerceService {
  constructor(
    @Inject(BRANDS_REPOSITORY) private readonly brands: BrandsRepository,
    @Inject(BrandsService) private readonly profiles: BrandsService,
  ) {}
  async read(brandID: string): Promise<BrandCommercePolicy | null> {
    await this.profiles.getPublicProfile(brandID);
    return this.document(brandID, await this.brands.findSettings(brandID)).policy;
  }
  readManaged(brandID: string, actor: Pick<AuthenticatedUser, 'id'>): Promise<BrandCommercePolicyDocument> {
    return this.brands.snapshot(async repository => {
      this.requireAccess(await repository.findCommerceAccess(brandID, actor.id));
      return this.document(brandID, await repository.findSettings(brandID));
    });
  }
  async update(brandID: string, actor: Pick<AuthenticatedUser, 'id'>, input: unknown): Promise<BrandCommercePolicyDocument> {
    const request = updateBrandCommercePolicySchema.safeParse(input);
    if (!request.success) throw new BadRequestException(BRAND_COMMERCE.failure.input);
    return this.brands.transaction(async repository => {
      this.requireAccess(await repository.lockCommerceAccess(brandID, actor.id));
      const saved = await repository.saveCommercePolicy(brandID, request.data.policy, request.data.expectedVersion);
      if (!saved) throw new ConflictException(BRAND_COMMERCE.failure.changed);
      return this.document(brandID, saved);
    });
  }
  private requireAccess(context: BrandCommerceAccess | undefined): void {
    if (!context || context.actor.status !== PUBLIC_PROFILE.userStatus || !PROFILE_EDITING.writableStatuses.some(status => status === context.brand.status)) {
      throw new ForbiddenException(BRAND_COMMERCE.failure.access);
    }
    const administrator = BRAND_COMMERCE.adminRoles.some(role => context.actor.roles.includes(role));
    const member = context.memberRole !== null && canAuthorProfile(context.actor.roles, {brandId: context.brand.id, creatorId: null});
    if (!administrator && !member) throw new ForbiddenException(BRAND_COMMERCE.failure.access);
  }
  private document(brandId: string, settings: Settings): BrandCommercePolicyDocument {
    const version = settings?.commercePolicyVersion ?? BRAND_COMMERCE.revision.unconfigured;
    const raw = settings?.metadata[COMMERCE_POLICY_KEY];
    if (raw === undefined) {
      if (version !== BRAND_COMMERCE.revision.unconfigured) throw new ConflictException(BRAND_COMMERCE.failure.persisted);
      return {brandId, version, policy: null};
    }
    const parsed = brandCommercePolicySchema.safeParse(raw);
    if (!Number.isInteger(version) || version < BRAND_COMMERCE.revision.initial || version > BRAND_COMMERCE.revision.maximum || !parsed.success) {
      throw new ConflictException(BRAND_COMMERCE.failure.persisted);
    }
    return {brandId, version, policy: parsed.data};
  }
}
