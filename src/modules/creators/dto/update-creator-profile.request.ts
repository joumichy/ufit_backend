import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayUnique, IsArray, IsIn, IsObject, IsOptional, IsString, IsUrl, Length, ValidateIf, ValidateNested } from 'class-validator';
import { PROFILE_EDITING, type WritableProfileStatus } from '../../../shared/domain/profile-editing.contract';
import { profileFieldProvided, trimNullableProfileText, trimProfileText } from '../../../shared/presentation/dto/profile-input';
import { CREATOR_SOCIAL_PLATFORMS, type CreatorSocialPlatform } from '../creator-social.contract';
const urlOptions = {...PROFILE_EDITING.url, protocols: [...PROFILE_EDITING.url.protocols]};
export class CreatorSocialAccountRequest {
  @IsIn([...CREATOR_SOCIAL_PLATFORMS]) platform!: CreatorSocialPlatform;
  @Transform(trimProfileText) @IsString() @Length(PROFILE_EDITING.limits.handleMin, PROFILE_EDITING.limits.handleMax) handle!: string;
  @Transform(trimNullableProfileText) @IsOptional() @IsUrl(urlOptions) url?: string | null;
}
export class UpdateCreatorProfileRequest {
  @ValidateIf(profileFieldProvided) @Transform(trimProfileText) @IsString()
  @Length(PROFILE_EDITING.limits.nameMin, PROFILE_EDITING.limits.creatorNameMax) displayName?: string;
  @Transform(trimNullableProfileText) @IsOptional() @IsString()
  @Length(PROFILE_EDITING.limits.bioMin, PROFILE_EDITING.limits.bioMax) bio?: string | null;
  @Transform(trimNullableProfileText) @IsOptional() @IsUrl(urlOptions) avatarUrl?: string | null;
  @ValidateIf(profileFieldProvided) @IsIn([...PROFILE_EDITING.writableStatuses]) status?: WritableProfileStatus;
  @ValidateIf(profileFieldProvided) @IsArray() @ArrayMaxSize(CREATOR_SOCIAL_PLATFORMS.length)
  @ArrayUnique((account: CreatorSocialAccountRequest) => account?.platform)
  @IsObject({each: true}) @ValidateNested({each: true}) @Type(() => CreatorSocialAccountRequest)
  socialAccounts?: CreatorSocialAccountRequest[];
}
