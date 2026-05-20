import type {
  CreatorApplicationRow,
  CreatorProfileRow,
  NewCreatorProfileRow
} from '../../shared/infrastructure/database/schema';

export interface CreatorsRepository {
  findProfileByUserId(userId: string): Promise<CreatorProfileRow | undefined>;
  findProfileByApplicationId(applicationId: string): Promise<CreatorProfileRow | undefined>;
  createProfile(input: NewCreatorProfileRow): Promise<CreatorProfileRow>;
  updateProfile(
    profileId: string,
    input: Partial<Pick<CreatorProfileRow, 'displayName' | 'bio' | 'avatarUrl' | 'status'>>
  ): Promise<CreatorProfileRow>;
  addInitialGradeHistory(profileId: string): Promise<void>;
}

export type CreatorApplicationForProvisioning = Pick<CreatorApplicationRow, 'id' | 'userId' | 'displayName'>;
