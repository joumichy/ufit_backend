import {Transform, Type} from 'class-transformer';
import {ArrayMaxSize, ArrayUnique, IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, IsUrl, IsUUID, Length, Max, Min, ValidateIf, ValidateNested} from 'class-validator';
import type {GenderTarget} from '../../../../shared/domain/gender-target';
import {GENDER_TARGETS} from '../../../../shared/domain/gender-target';
import {PROFILE_EDITING} from '../../../../shared/domain/profile-editing.contract';
import {fieldProvided, trimNullableText, trimText} from '../../../../shared/presentation/dto/text-input';
import {OUTFIT_EDITING, OUTFIT_ITEM_TYPES, OUTFIT_STATUS} from '../../domain/outfit-editing.contract';
import type {OutfitItemType, OutfitStatus} from '../../domain/outfit.types';
const limits = OUTFIT_EDITING.limits;
export class CreateOutfitItemDto {
  @IsOptional() @IsUUID() productId?: string | null;
  @Transform(trimNullableText) @IsOptional() @IsString() @Length(limits.labelMin, limits.labelMax) externalLabel?: string | null;
  @IsIn(OUTFIT_ITEM_TYPES) itemType!: OutfitItemType;
  @IsInt() @Min(limits.integerMin) @Max(limits.itemsMax) position!: number;
  @IsBoolean() isRequired!: boolean;
  @IsBoolean() isShoppable!: boolean;
  @Transform(trimNullableText) @IsOptional() @IsString() @Length(limits.descriptionMin, limits.noteMax) stylingNote?: string | null;
}
export class EditOutfitItemDto extends CreateOutfitItemDto { @ValidateIf(fieldProvided) @IsUUID() id?: string; }
export class CreateOutfitImageDto {
  @Transform(trimText) @IsUrl({...PROFILE_EDITING.url, protocols: [...PROFILE_EDITING.url.protocols]}) url!: string;
  @IsInt() @Min(limits.integerMin) @Max(limits.imagesMax) position!: number;
}
export class EditOutfitImageDto extends CreateOutfitImageDto { @ValidateIf(fieldProvided) @IsUUID() id?: string; }
export class OutfitFieldsDto {
  @Transform(trimText) @IsString() @Length(limits.titleMin, limits.titleMax) title!: string;
  @Transform(trimText) @IsString() @Length(limits.descriptionMin, limits.descriptionMax) description!: string;
  @IsOptional() @IsIn(GENDER_TARGETS) genderTarget?: GenderTarget | null;
  @IsArray() @ArrayMaxSize(limits.tagsMax) @ArrayUnique() @IsUUID(undefined, {each: true}) tagIds!: string[];
}
export class CreateOutfitDto extends OutfitFieldsDto {
  @IsOptional() @IsUUID() creatorId?: string;
  @IsOptional() @IsUUID() brandId?: string;
  @IsUUID() requestId!: string;
  @IsArray() @ArrayMaxSize(limits.itemsMax) @ArrayUnique((item: CreateOutfitItemDto) => item?.position)
  @IsObject({each: true}) @ValidateNested({each: true}) @Type(() => CreateOutfitItemDto) items!: CreateOutfitItemDto[];
  @IsArray() @ArrayMaxSize(limits.imagesMax) @ArrayUnique((image: CreateOutfitImageDto) => image?.position)
  @IsObject({each: true}) @ValidateNested({each: true}) @Type(() => CreateOutfitImageDto) images!: CreateOutfitImageDto[];
}
export class OutfitVersionDto { @IsInt() @Min(OUTFIT_EDITING.versionInitial) @Max(limits.integerMax) expectedVersion!: number; }
export class UpdateOutfitDto extends OutfitFieldsDto {
  @IsInt() @Min(OUTFIT_EDITING.versionInitial) @Max(limits.integerMax) expectedVersion!: number;
  @IsArray() @ArrayMaxSize(limits.itemsMax) @ArrayUnique((item: EditOutfitItemDto) => item?.position)
  @IsObject({each: true}) @ValidateNested({each: true}) @Type(() => EditOutfitItemDto) items!: EditOutfitItemDto[];
  @IsArray() @ArrayMaxSize(limits.imagesMax) @ArrayUnique((image: EditOutfitImageDto) => image?.position)
  @IsObject({each: true}) @ValidateNested({each: true}) @Type(() => EditOutfitImageDto) images!: EditOutfitImageDto[];
}
export class ReviewOutfitDto extends OutfitVersionDto {
  @IsIn([OUTFIT_STATUS.published, OUTFIT_STATUS.rejected]) decision!: Extract<OutfitStatus, 'published' | 'rejected'>;
  @Transform(trimNullableText) @IsOptional() @IsString() @Length(limits.labelMin, limits.noteMax) rejectionReason?: string | null;
}
