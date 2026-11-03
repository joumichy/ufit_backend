import {CURRENCY_CODES} from '../../../../shared/domain/currencies';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayUnique, IsArray, IsIn, IsInt, IsObject, IsOptional, IsString, IsUrl, IsUUID, Length, Max, Min, ValidateIf, ValidateNested } from 'class-validator';
import { GENDER_TARGETS } from '../../../../shared/domain/gender-target';
import { PRODUCT_EDITING, PRODUCT_IMAGE_KINDS, PRODUCT_STATUS, PRODUCT_VARIANT_STATUSES } from '../../domain/product-contract';
import type { GenderTarget, ProductImage, ProductVariantStatus } from '../../domain/product.types';
import { fieldProvided, trimNullableText, trimText } from '../../../../shared/presentation/dto/text-input';
const limits = PRODUCT_EDITING.limits;
const urlOptions = {protocols: ['http', 'https'], require_protocol: true, require_tld: false};
export class CreateProductVariantDto {
  @Transform(trimNullableText) @IsOptional() @IsString() @Length(limits.optionalTextMin, limits.optionMax) size?: string | null;
  @Transform(trimNullableText) @IsOptional() @IsString() @Length(limits.optionalTextMin, limits.optionMax) color?: string | null;
  @Transform(trimText) @IsString() @Length(limits.skuMin, limits.skuMax) sku!: string;
  @IsInt() @Min(limits.integerMin) @Max(limits.integerMax) stockQuantity!: number;
  @IsOptional() @IsInt() @Min(limits.integerMin) @Max(limits.integerMax) priceOverride?: number | null;
}
export class EditProductVariantDto extends CreateProductVariantDto {
  @ValidateIf(fieldProvided) @IsUUID() id?: string;
  @ValidateIf(fieldProvided) @IsInt() @Min(limits.integerMin) @Max(limits.integerMax) expectedStockQuantity?: number;
  @IsIn(PRODUCT_VARIANT_STATUSES) status!: ProductVariantStatus;
}
export class CreateProductImageDto {
  @Transform(trimText) @IsUrl(urlOptions) url!: string;
  @IsInt() @Min(limits.integerMin) @Max(limits.imagesMax) position!: number;
  @IsIn(PRODUCT_IMAGE_KINDS) kind!: ProductImage['kind'];
}
export class EditProductImageDto extends CreateProductImageDto {
  @ValidateIf(fieldProvided) @IsUUID() id?: string;
}
export class ProductFieldsDto {
  @Transform(trimText) @IsString() @Length(limits.nameMin, limits.nameMax) name!: string;
  @Transform(trimText) @IsString() @Length(limits.descriptionMin, limits.descriptionMax) description!: string;
  @Transform(trimText) @IsString() @Length(limits.categoryMin, limits.categoryMax) category!: string;
  @IsOptional() @IsIn(GENDER_TARGETS) genderTarget?: GenderTarget | null;
  @IsInt() @Min(limits.integerMin) @Max(limits.integerMax) basePrice!: number;
  @IsIn(CURRENCY_CODES) currency!: string;
  @Transform(trimNullableText) @IsOptional() @IsString() @Length(limits.optionalTextMin, limits.detailMax) material?: string | null;
  @Transform(trimNullableText) @IsOptional() @IsString() @Length(limits.optionalTextMin, limits.detailMax) careInstructions?: string | null;
}
export class CreateProductDto extends ProductFieldsDto {
  @IsUUID() brandId!: string;
  @IsUUID() requestId!: string;
  @IsArray() @ArrayMaxSize(limits.variantsMax) @ArrayUnique((variant: CreateProductVariantDto) => variant?.sku)
  @IsObject({each: true}) @ValidateNested({each: true}) @Type(() => CreateProductVariantDto) variants!: CreateProductVariantDto[];
  @IsArray() @ArrayMaxSize(limits.imagesMax) @ArrayUnique((image: CreateProductImageDto) => image?.position)
  @IsObject({each: true}) @ValidateNested({each: true}) @Type(() => CreateProductImageDto) images!: CreateProductImageDto[];
}
export class ProductVersionDto {
  @IsInt() @Min(PRODUCT_EDITING.versionInitial) @Max(limits.integerMax) expectedVersion!: number;
}
export class UpdateProductDto extends ProductFieldsDto {
  @IsInt() @Min(PRODUCT_EDITING.versionInitial) @Max(limits.integerMax) expectedVersion!: number;
  @IsArray() @ArrayMaxSize(limits.variantsMax) @ArrayUnique((variant: EditProductVariantDto) => variant?.sku)
  @IsObject({each: true}) @ValidateNested({each: true}) @Type(() => EditProductVariantDto) variants!: EditProductVariantDto[];
  @IsArray() @ArrayMaxSize(limits.imagesMax) @ArrayUnique((image: CreateProductImageDto) => image?.position)
  @IsObject({each: true}) @ValidateNested({each: true}) @Type(() => EditProductImageDto) images!: EditProductImageDto[];
}
export class UpdateProductStockDto extends ProductVersionDto {
  @IsUUID() variantId!: string;
  @IsInt() @Min(limits.integerMin) @Max(limits.integerMax) expectedStockQuantity!: number;
  @IsInt() @Min(limits.integerMin) @Max(limits.integerMax) stockQuantity!: number;
}
