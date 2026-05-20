import { IsIn, IsOptional, IsString, IsUrl, Length } from 'class-validator';

export class UpdateBrandProfileRequest {
  @IsOptional()
  @IsString()
  @Length(2, 120)
  brandName?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  websiteUrl?: string;

  @IsOptional()
  @IsString()
  @Length(0, 1000)
  bio?: string;

  @IsOptional()
  @IsIn(['active', 'paused'])
  status?: 'active' | 'paused';
}
