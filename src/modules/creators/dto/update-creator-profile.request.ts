import { IsIn, IsOptional, IsString, IsUrl, Length } from 'class-validator';

export class UpdateCreatorProfileRequest {
  @IsOptional()
  @IsString()
  @Length(2, 80)
  displayName?: string;

  @IsOptional()
  @IsString()
  @Length(0, 1000)
  bio?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  avatarUrl?: string;

  @IsOptional()
  @IsIn(['active', 'paused'])
  status?: 'active' | 'paused';
}
