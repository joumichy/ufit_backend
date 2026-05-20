import { IsEmail, IsString, IsUrl, Length } from 'class-validator';

export class SubmitBrandApplicationRequest {
  @IsString()
  @Length(2, 120)
  brandName!: string;

  @IsEmail()
  email!: string;

  @IsUrl({ require_tld: false })
  websiteUrl!: string;

  @IsString()
  @Length(2, 80)
  productCategory!: string;

  @IsString()
  @Length(20, 2000)
  positioning!: string;
}
