import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUrl, Length, ValidateIf } from 'class-validator';
import { PROFILE_EDITING, type WritableProfileStatus } from '../../../shared/domain/profile-editing.contract';
import { fieldProvided, trimNullableText, trimText } from '../../../shared/presentation/dto/text-input';
export class UpdateBrandProfileRequest {
  @ValidateIf(fieldProvided) @Transform(trimText) @IsString()
  @Length(PROFILE_EDITING.limits.nameMin, PROFILE_EDITING.limits.brandNameMax) brandName?: string;
  @Transform(trimNullableText) @IsOptional()
  @IsUrl({...PROFILE_EDITING.url, protocols: [...PROFILE_EDITING.url.protocols]}) websiteUrl?: string | null;
  @Transform(trimNullableText) @IsOptional() @IsString()
  @Length(PROFILE_EDITING.limits.bioMin, PROFILE_EDITING.limits.bioMax) bio?: string | null;
  @ValidateIf(fieldProvided) @IsIn([...PROFILE_EDITING.writableStatuses]) status?: WritableProfileStatus;
}
