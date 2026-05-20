import { IsEmail, IsOptional, IsString, IsUrl, Length } from 'class-validator';

export class SubmitCreatorApplicationRequest {
  @IsString()
  @Length(2, 80)
  displayName!: string;

  @IsEmail()
  email!: string;

  @IsUrl({ require_tld: false })
  portfolioUrl!: string;

  @IsString()
  @Length(20, 2000)
  motivation!: string;

  @IsOptional()
  @IsString()
  @Length(5, 1000)
  audienceSummary?: string;
}
