import { trimApplicationText } from "./application-text";
import { APPLICATION } from "../types/application-contract";
import { Transform, Type } from "class-transformer";
import { IsDefined, IsObject, ValidateNested } from "class-validator";
import { CreatorApplicationDossierRequest } from "./application-dossier.request";
import { IsEmail, IsOptional, IsString, IsUrl, Length } from 'class-validator';

export class SubmitCreatorApplicationRequest {
  @IsString()
  @Length(APPLICATION.limits.nameMin, APPLICATION.limits.creatorNameMax)
  @Transform(trimApplicationText)
  displayName!: string;

  @IsEmail()
  @Transform(trimApplicationText)
  email!: string;

  @IsOptional()
  @IsUrl({...APPLICATION.url, protocols: [...APPLICATION.url.protocols]})
  @Transform(trimApplicationText)
  portfolioUrl?: string | null;

  @IsString()
  @Length(APPLICATION.limits.textMin, APPLICATION.limits.textMax)
  @Transform(trimApplicationText)
  motivation!: string;

  @IsOptional()
  @IsString()
  @Length(APPLICATION.limits.optionalMin, APPLICATION.limits.optionalMax)
  @Transform(trimApplicationText)
  audienceSummary?: string;
  @IsDefined() @IsObject() @ValidateNested() @Type(() => CreatorApplicationDossierRequest)
  dossier!: CreatorApplicationDossierRequest;
}
