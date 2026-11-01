import { BrandCommerceService } from './brand-commerce.service';
import { Controller, Get, Inject, Param, ParseUUIDPipe } from '@nestjs/common';
import { BrandsService } from './brands.service';
const PUBLIC_BRANDS_ROUTE = 'public/brands';
@Controller(PUBLIC_BRANDS_ROUTE)
export class PublicBrandsController {
  constructor(@Inject(BrandsService) private readonly brands: BrandsService, @Inject(BrandCommerceService) private readonly commerce: BrandCommerceService) {}
  @Get(':id/commerce-policy')
  policy(@Param('id', ParseUUIDPipe) id: string) { return this.commerce.read(id); }
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) { return this.brands.getPublicProfile(id); }
}
