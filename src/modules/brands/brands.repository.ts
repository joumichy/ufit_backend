import type {
  BrandApplicationRow,
  BrandMemberRow,
  BrandProfileRow,
  NewBrandMemberRow,
  NewBrandProfileRow
} from '../../shared/infrastructure/database/schema';

export interface BrandsRepository {
  findProfileByApplicationId(applicationId: string): Promise<BrandProfileRow | undefined>;
  findProfileById(brandProfileId: string): Promise<BrandProfileRow | undefined>;
  createProfile(input: NewBrandProfileRow): Promise<BrandProfileRow>;
  createOwnerMember(input: NewBrandMemberRow): Promise<BrandMemberRow>;
  createDefaultSettings(brandProfileId: string): Promise<void>;
  findActiveMember(brandProfileId: string, userId: string): Promise<BrandMemberRow | undefined>;
  updateProfile(
    brandProfileId: string,
    input: Partial<Pick<BrandProfileRow, 'brandName' | 'bio' | 'websiteUrl' | 'status'>>
  ): Promise<BrandProfileRow>;
}

export type BrandApplicationForProvisioning = Pick<
  BrandApplicationRow,
  'id' | 'userId' | 'brandName' | 'websiteUrl'
>;
