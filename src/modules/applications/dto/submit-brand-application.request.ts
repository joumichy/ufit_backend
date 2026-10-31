import { trimApplicationText } from "./application-text";
import { APPLICATION } from "../types/application-contract";
import { Transform, Type } from "class-transformer";
import { IsDefined, IsObject, ValidateNested } from "class-validator";
import { BrandApplicationDossierRequest } from "./application-dossier.request";
import { IsEmail, IsString, IsUrl, Length } from 'class-validator';

export class SubmitBrandApplicationRequest {
  @IsString()
  @Length(APPLICATION.limits.nameMin, APPLICATION.limits.brandNameMax)
  @Transform(trimApplicationText)
  brandName!: string;

  @IsEmail()
  @Transform(trimApplicationText)
  email!: string;

  @IsUrl({...APPLICATION.url, protocols: [...APPLICATION.url.protocols]})
  @Transform(trimApplicationText)
  websiteUrl!: string;

  @IsString()
  @Length(APPLICATION.limits.nameMin, APPLICATION.limits.creatorNameMax)
  @Transform(trimApplicationText)
  productCategory!: string;

  @IsString()
  @Length(APPLICATION.limits.textMin, APPLICATION.limits.textMax)
  @Transform(trimApplicationText)
  positioning!: string;
  @IsDefined() @IsObject() @ValidateNested() @Type(() => BrandApplicationDossierRequest)
  dossier!: BrandApplicationDossierRequest;
}
