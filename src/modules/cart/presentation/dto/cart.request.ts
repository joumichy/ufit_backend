import { IsInt, IsOptional, IsUUID, Min } from 'class-validator';

const MINIMUM_QUANTITY = 1;
export class AddCartItemRequest {
  @IsUUID() productVariantId!: string;
  @IsInt() @Min(MINIMUM_QUANTITY) quantity!: number;
  @IsOptional() @IsUUID() sourceOutfitId?: string;
}
export class UpdateCartQuantityRequest {
  @IsInt() @Min(MINIMUM_QUANTITY) quantity!: number;
}
