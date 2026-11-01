import type { brandSettings } from '../../shared/infrastructure/database/schema';
import type { BrandCommercePolicy } from './commerce-policy';
import type {PublicBrandProfile} from './public-brand.contract';
import type {
  BrandApplicationRow,
  BrandMemberRow,
  BrandProfileRow,
  NewBrandMemberRow,
  NewBrandProfileRow
} from '../../shared/infrastructure/database/schema';

export interface BrandsRepository {
  findPublicProfileById(id: string): Promise<PublicBrandProfile | undefined>;
  findSettings(brandProfileId: string): Promise<typeof brandSettings.$inferSelect | undefined>;
  saveCommercePolicy(brandProfileId: string, policy: BrandCommercePolicy): Promise<void>;
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

export type BrandApplicationForProvisioning = Pick<
  BrandApplicationRow,
  'id' | 'userId' | 'brandName' | 'websiteUrl'
>;
