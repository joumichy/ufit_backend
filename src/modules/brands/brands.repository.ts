import type { brandSettings } from '../../shared/infrastructure/database/schema';
import type { BrandCommercePolicy } from './commerce-policy';
import type {PublicBrandProfile} from './public-brand.contract';
import type {UserRole, UserStatus} from '../identity/domain/user.types';
import type {
  BrandApplicationRow,
  BrandMemberRow,
  BrandProfileRow,
  NewBrandMemberRow,
  NewBrandProfileRow
} from '../../shared/infrastructure/database/schema';

export interface BrandsRepository {
  transaction<T>(operation: (repository: BrandsRepository) => Promise<T>): Promise<T>;
  snapshot<T>(operation: (repository: BrandsRepository) => Promise<T>): Promise<T>;
  findManagementAccess(brandId: string, actorId: string): Promise<BrandManagementAccess | undefined>;
  lockManagementAccess(brandId: string, actorId: string): Promise<BrandManagementAccess | undefined>;
  findPublicProfileById(id: string): Promise<PublicBrandProfile | undefined>;
  findSettings(brandProfileId: string): Promise<typeof brandSettings.$inferSelect | undefined>;
  saveCommercePolicy(brandProfileId: string, policy: BrandCommercePolicy, expectedVersion: number): Promise<typeof brandSettings.$inferSelect | undefined>;
  findProfileByApplicationId(applicationId: string): Promise<BrandProfileRow | undefined>;
  findProfileById(brandProfileId: string): Promise<BrandProfileRow | undefined>;
  createProfile(input: NewBrandProfileRow): Promise<BrandProfileRow>;
  createOwnerMember(input: NewBrandMemberRow): Promise<BrandMemberRow>;
  createDefaultSettings(brandProfileId: string): Promise<void>;
  findActiveMember(brandProfileId: string, userId: string): Promise<BrandMemberRow | undefined>;
  updateProfile(
    brandProfileId: string,
    input: Partial<Pick<BrandProfileRow, 'brandName' | 'bio' | 'websiteUrl' | 'status'>>,
    userId: string
  ): Promise<BrandProfileRow | undefined>;
}

export interface BrandManagementAccess {
  brand: Pick<BrandProfileRow, 'id' | 'brandName' | 'status'>;
  actor: {status: UserStatus; roles: UserRole[]};
  memberRole: BrandMemberRow['role'] | null;
}

export type BrandApplicationForProvisioning = Pick<
  BrandApplicationRow,
  'id' | 'userId' | 'brandName' | 'websiteUrl'
>;
