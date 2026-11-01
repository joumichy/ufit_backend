import { PROFILE_EDITING, PROFILE_STATUS } from '../../shared/domain/profile-editing.contract';
import {PUBLIC_PROFILE} from '../../shared/domain/public-profile.contract';
import {PUBLIC_OUTFIT, PUBLIC_OUTFIT_VISIBILITIES} from '../outfits/domain/public-outfit.contract';
import {PRODUCT_STATUS} from '../products/domain/product-contract';
import type {PublicBrandProfile} from './public-brand.contract';
import {READ_SNAPSHOT, type DatabaseSession} from "../../shared/infrastructure/database/database-session";
import { BRAND_COMMERCE, COMMERCE_POLICY_KEY, type BrandCommercePolicy } from './commerce-policy';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ne, sql, inArray, isNull } from 'drizzle-orm';
import { DatabaseService } from '../../shared/infrastructure/database/database.service';
import {
  brandMembers,
  brandProfiles,
  brandSettings,
  outfits,
  products,
  users,
  userRoles,
  type BrandMemberRow,
  type BrandProfileRow,
  type NewBrandMemberRow,
  type NewBrandProfileRow
} from '../../shared/infrastructure/database/schema';
import type { BrandsRepository, BrandCommerceAccess } from './brands.repository';

@Injectable()
export class DrizzleBrandsRepository implements BrandsRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseSession) {}

  transaction<T>(operation: (repository: BrandsRepository) => Promise<T>): Promise<T> {
    return this.database.db.transaction(tx => operation(new DrizzleBrandsRepository({db: tx})));
  }
  snapshot<T>(operation: (repository: BrandsRepository) => Promise<T>): Promise<T> {
    return this.database.db.transaction(tx => operation(new DrizzleBrandsRepository({db: tx})), READ_SNAPSHOT);
  }
  findCommerceAccess(brandId: string, actorId: string) { return this.commerceAccess(brandId, actorId, false); }
  lockCommerceAccess(brandId: string, actorId: string) { return this.commerceAccess(brandId, actorId, true); }
  private async commerceAccess(brandId: string, actorId: string, locking: boolean): Promise<BrandCommerceAccess | undefined> {
    const actorQuery = this.database.db.select({status: users.status}).from(users).where(eq(users.id, actorId));
    const [actor] = locking ? await actorQuery.for(BRAND_COMMERCE.persistence.lock) : await actorQuery;
    if (!actor) return undefined;
    const rolesQuery = this.database.db.select({role: userRoles.role}).from(userRoles).where(eq(userRoles.userId, actorId)).orderBy(userRoles.role);
    const roles = locking ? await rolesQuery.for(BRAND_COMMERCE.persistence.lock) : await rolesQuery;
    const brandQuery = this.database.db.select({id: brandProfiles.id, brandName: brandProfiles.brandName, status: brandProfiles.status})
      .from(brandProfiles).where(eq(brandProfiles.id, brandId));
    const [brand] = locking ? await brandQuery.for(BRAND_COMMERCE.persistence.lock) : await brandQuery;
    if (!brand) return undefined;
    const memberQuery = this.database.db.select({role: brandMembers.role}).from(brandMembers)
      .where(and(eq(brandMembers.brandProfileId, brandId), eq(brandMembers.userId, actorId), eq(brandMembers.status, PROFILE_EDITING.persistence.memberActive)));
    const [member] = locking ? await memberQuery.for(BRAND_COMMERCE.persistence.lock) : await memberQuery;
    return {brand, actor: {status: actor.status, roles: roles.map(row => row.role)}, memberRole: member?.role ?? null};
  }

  async findPublicProfileById(id: string): Promise<PublicBrandProfile | undefined> {
    const [profile] = await this.database.db.select({id: brandProfiles.id, brandName: brandProfiles.brandName, slug: brandProfiles.slug,
      bio: brandProfiles.bio, websiteUrl: brandProfiles.websiteUrl, stats: {
        publishedOutfits: sql<number>`(select count(*)::integer from ${outfits} where ${and(eq(outfits.brandId, brandProfiles.id), isNull(outfits.creatorId),
          eq(outfits.status, PUBLIC_OUTFIT.status), inArray(outfits.visibility, PUBLIC_OUTFIT_VISIBILITIES))})`,
        activeProducts: sql<number>`(select count(*)::integer from ${products} where ${and(eq(products.brandId, brandProfiles.id), eq(products.status, PRODUCT_STATUS.active))})`,
      }})
      .from(brandProfiles).where(and(eq(brandProfiles.id, id), eq(brandProfiles.status, PUBLIC_PROFILE.status)));
    return profile;
  }

  async findSettings(brandProfileId: string) {
    return this.database.db.query.brandSettings.findFirst({where: eq(brandSettings.brandProfileId,brandProfileId)});
  }
  async saveCommercePolicy(brandProfileId: string, policy: BrandCommercePolicy, expectedVersion: number) {
    const patch = {[COMMERCE_POLICY_KEY]:policy};
    await this.database.db.insert(brandSettings).values({brandProfileId}).onConflictDoNothing();
    const [row] = await this.database.db.update(brandSettings).set({
      metadata: sql`${brandSettings.metadata} || ${JSON.stringify(patch)}::jsonb`,
      commercePolicyVersion: sql`${brandSettings.commercePolicyVersion} + ${BRAND_COMMERCE.revision.step}`, updatedAt: new Date(),
    }).where(and(eq(brandSettings.brandProfileId, brandProfileId), eq(brandSettings.commercePolicyVersion, expectedVersion))).returning();
    return row;
  }

  async findProfileByApplicationId(applicationId: string): Promise<BrandProfileRow | undefined> {
    return this.database.db.query.brandProfiles.findFirst({
      where: eq(brandProfiles.applicationId, applicationId)
    });
  }

  async findProfileById(brandProfileId: string): Promise<BrandProfileRow | undefined> {
    return this.database.db.query.brandProfiles.findFirst({
      where: eq(brandProfiles.id, brandProfileId)
    });
  }

  async createProfile(input: NewBrandProfileRow): Promise<BrandProfileRow> {
    const [row] = await this.database.db.insert(brandProfiles).values(input).returning();
    return row;
  }

  async createOwnerMember(input: NewBrandMemberRow): Promise<BrandMemberRow> {
    const [row] = await this.database.db.insert(brandMembers).values(input).returning();
    return row;
  }

  async createDefaultSettings(brandProfileId: string): Promise<void> {
    await this.database.db.insert(brandSettings).values({ brandProfileId }).onConflictDoNothing();
  }

  async findActiveMember(brandProfileId: string, userId: string): Promise<BrandMemberRow | undefined> {
    return this.database.db.query.brandMembers.findFirst({
      where: (table, { and, eq }) =>
        and(eq(table.brandProfileId, brandProfileId), eq(table.userId, userId), eq(table.status, PROFILE_EDITING.persistence.memberActive))
    });
  }

  async updateProfile(
    brandProfileId: string,
    input: Partial<Pick<BrandProfileRow, 'brandName' | 'bio' | 'websiteUrl' | 'status'>>,
    userId: string
  ): Promise<BrandProfileRow | undefined> {
    const [row] = await this.database.db
      .update(brandProfiles)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(brandProfiles.id, brandProfileId), ne(brandProfiles.status, PROFILE_STATUS.suspended),
        sql`exists (select ${PROFILE_EDITING.persistence.existsProjection} from ${brandMembers} where ${brandMembers.brandProfileId} = ${brandProfiles.id}
          and ${brandMembers.userId} = ${userId} and ${brandMembers.status} = ${PROFILE_EDITING.persistence.memberActive})`))
      .returning();
    return row;
  }
}
