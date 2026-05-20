import { IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

export class UpdateMeRequest {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  displayName?: string | null;

  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(512)
  avatarUrl?: string | null;
}
