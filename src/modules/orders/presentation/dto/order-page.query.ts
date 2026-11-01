import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
const PAGE_LIMIT = { default: 20, minimum: 1, maximum: 50 } as const;
export class OrderPageQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(PAGE_LIMIT.minimum) @Max(PAGE_LIMIT.maximum)
  limit: number = PAGE_LIMIT.default;
  @IsOptional() @IsUUID() cursor?: string;
}
