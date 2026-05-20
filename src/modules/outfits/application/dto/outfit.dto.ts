import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUrl, IsUUID, Min, ValidateNested } from 'class-validator';

export class CreateOutfitItemDto {
  @IsOptional()
  @IsUUID()
  productId?: string;

  @IsOptional()
  @IsString()
  externalLabel?: string;

  @IsIn(['top', 'bottom', 'shoes', 'bag', 'accessory', 'outerwear'])
  itemType!: 'top' | 'bottom' | 'shoes' | 'bag' | 'accessory' | 'outerwear';

  @IsInt()
  @Min(0)
  position!: number;

  @IsBoolean()
  isRequired!: boolean;

  @IsBoolean()
  isShoppable!: boolean;

  @IsOptional()
  @IsString()
  stylingNote?: string;
}

export class CreateOutfitImageDto {
  @IsUrl({ require_tld: false })
  url!: string;

  @IsInt()
  @Min(0)
  position!: number;
}

export class CreateOutfitDto {
  @IsOptional()
  @IsUUID()
  creatorId?: string;

  @IsOptional()
  @IsUUID()
  brandId?: string;

  @IsString()
  @IsNotEmpty()
  title!: string;

  @IsString()
  @IsNotEmpty()
  description!: string;

  @IsUrl({ require_tld: false })
  coverImageUrl!: string;

  @IsOptional()
  @IsIn(['male', 'female', 'unisex'])
  genderTarget?: 'male' | 'female' | 'unisex';

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateOutfitItemDto)
  items!: CreateOutfitItemDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateOutfitImageDto)
  images?: CreateOutfitImageDto[];
}

export class ReviewOutfitDto {
  @IsIn(['published', 'rejected'])
  decision!: 'published' | 'rejected';

  @IsOptional()
  @IsUUID()
  reviewerId?: string;

  @IsOptional()
  @IsString()
  rejectionReason?: string;
}
