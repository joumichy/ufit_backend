import { IsArray, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUrl, IsUUID, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateProductVariantDto {
  @IsOptional()
  @IsString()
  size?: string;

  @IsOptional()
  @IsString()
  color?: string;

  @IsString()
  @IsNotEmpty()
  sku!: string;

  @IsInt()
  @Min(0)
  stockQuantity!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  priceOverride?: number;
}

export class CreateProductImageDto {
  @IsUrl({ require_tld: false })
  url!: string;

  @IsInt()
  @Min(0)
  position!: number;

  @IsIn(['product', 'worn', 'detail', 'lookbook'])
  kind!: 'product' | 'worn' | 'detail' | 'lookbook';
}

export class CreateProductDto {
  @IsUUID()
  brandId!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsNotEmpty()
  slug!: string;

  @IsString()
  @IsNotEmpty()
  description!: string;

  @IsString()
  @IsNotEmpty()
  category!: string;

  @IsOptional()
  @IsIn(['male', 'female', 'unisex'])
  genderTarget?: 'male' | 'female' | 'unisex';

  @IsInt()
  @Min(0)
  basePrice!: number;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsString()
  material?: string;

  @IsOptional()
  @IsString()
  careInstructions?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateProductVariantDto)
  variants?: CreateProductVariantDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateProductImageDto)
  images?: CreateProductImageDto[];
}

export class ReviewProductDto {
  @IsIn(['active', 'rejected'])
  decision!: 'active' | 'rejected';

  @IsOptional()
  @IsUUID()
  reviewerId?: string;

  @IsOptional()
  @IsString()
  rejectionReason?: string;
}
