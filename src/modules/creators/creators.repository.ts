import type { CreatorSocialAccountInput } from './creator-social.contract';
import type {PublicCreatorProfile} from './public-creator.contract';
import type { creatorSocialAccounts } from '../../shared/infrastructure/database/schema';
import type {
  CreatorApplicationRow,
  CreatorProfileRow,
  NewCreatorProfileRow
} from '../../shared/infrastructure/database/schema';

export interface CreatorProfileDetails {profile: CreatorProfileRow; socialAccounts: Pick<typeof creatorSocialAccounts.$inferSelect, 'platform' | 'handle' | 'url'>[];}
export interface CreatorsRepository {
  findPublicProfileById(id: string): Promise<PublicCreatorProfile | undefined>;
  findDetailsByUserId(userId: string): Promise<CreatorProfileDetails | undefined>;
  findProfileByUserId(userId: string): Promise<CreatorProfileRow | undefined>;
  findProfileByApplicationId(applicationId: string): Promise<CreatorProfileRow | undefined>;
  createProfile(input: NewCreatorProfileRow): Promise<CreatorProfileRow>;
  updateProfile(
    profileId: string,
    input: Partial<Pick<CreatorProfileRow, 'displayName' | 'bio' | 'avatarUrl' | 'status'>> & {socialAccounts?: CreatorSocialAccountInput[]},
    userId: string
  ): Promise<CreatorProfileRow | undefined>;
  addInitialGradeHistory(profileId: string): Promise<void>;
}

export type CreatorApplicationForProvisioning = Pick<CreatorApplicationRow, 'id' | 'userId' | 'displayName'>;
