import { Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUrl, IsUUID, Min, ValidateNested } from 'class-validator';

export class CreateEditorialItemDto {
  @IsIn(['outfit', 'product'])
  itemType!: 'outfit' | 'product';

  @IsOptional()
  @IsUUID()
  outfitId?: string;

  @IsOptional()
  @IsUUID()
  productId?: string;

  @IsInt()
  @Min(0)
  position!: number;
}

export class CreateEditorialCollectionDto {
  @IsString()
  @IsNotEmpty()
  title!: string;

  @IsOptional()
  @IsString()
  subtitle?: string;

  @IsString()
  @IsNotEmpty()
  description!: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  coverImageUrl?: string;

  @IsOptional()
  @IsUUID()
  createdBy?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateEditorialItemDto)
  items?: CreateEditorialItemDto[];
}
