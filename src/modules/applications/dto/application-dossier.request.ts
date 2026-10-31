import { Transform } from "class-transformer";
import { trimApplicationText, trimApplicationUrls } from "./application-text";
import { ArrayMaxSize, ArrayMinSize, IsISO31661Alpha2, IsOptional, IsString, IsUrl, Length, Matches } from "class-validator";
import { APPLICATION } from "../types/application-contract";
const urlOptions = { ...APPLICATION.url, protocols: [...APPLICATION.url.protocols] };
export class CreatorApplicationDossierRequest {
  @Transform(trimApplicationText)
  @IsUrl(urlOptions) instagramUrl!: string;
  @Transform(trimApplicationText)
  @IsOptional() @IsUrl(urlOptions) tiktokUrl?: string | null;
  @Transform(trimApplicationText)
  @IsString() @Length(APPLICATION.limits.detailMin, APPLICATION.limits.shortMax) dominantStyle!: string;
  @Transform(trimApplicationText)
  @IsString() @Length(APPLICATION.limits.detailMin, APPLICATION.limits.optionalMax) brandsWorn!: string;
  @Transform(trimApplicationUrls)
  @ArrayMinSize(APPLICATION.limits.examples) @ArrayMaxSize(APPLICATION.limits.examples) @IsUrl(urlOptions, {each: true}) outfitExampleUrls!: string[];
}
export class BrandApplicationDossierRequest {
  @Transform(trimApplicationText)
  @IsUrl(urlOptions) instagramUrl!: string;
  @Transform(trimApplicationText)
  @Matches(APPLICATION.country) @IsISO31661Alpha2() country!: string;
  @Transform(trimApplicationText)
  @IsString() @Length(APPLICATION.limits.detailMin, APPLICATION.limits.optionalMax) priceRange!: string;
  @Transform(trimApplicationText)
  @IsUrl(urlOptions) lookbookUrl!: string;
  @Transform(trimApplicationText)
  @IsString() @Length(APPLICATION.limits.detailMin, APPLICATION.limits.textMax) shippingCapabilities!: string;
  @Transform(trimApplicationText)
  @IsString() @Length(APPLICATION.limits.detailMin, APPLICATION.limits.textMax) returnPolicy!: string;
  @Transform(trimApplicationText)
  @IsOptional() @IsString() @Length(APPLICATION.limits.detailMin, APPLICATION.limits.textMax) commissionProposal?: string | null;
}
