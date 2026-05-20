import { Body, Controller, Get, Inject, NotFoundException, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Roles } from '../../../shared/presentation/decorators/roles.decorator';
import { AuthGuard } from '../../../shared/presentation/guards/auth.guard';
import { RoleGuard } from '../../../shared/presentation/guards/role.guard';
import { ProductsService } from '../application/products.service';
import { CreateProductDto, ReviewProductDto } from '../application/dto/product.dto';
import { PRODUCT_REPOSITORY, type ProductRepository } from '../domain/product.types';

@Controller('products')
export class ProductsController {
  constructor(
    @Inject(ProductsService) private readonly productsService: ProductsService,
    @Inject(PRODUCT_REPOSITORY) private readonly products: ProductRepository
  ) {}

  @Post()
  @UseGuards(AuthGuard, RoleGuard)
  @Roles('brand_owner', 'brand_manager', 'admin', 'super_admin')
  createProduct(@Body() body: CreateProductDto) {
    return this.productsService.createProduct(body);
  }

  @Patch(':id/submit')
  @UseGuards(AuthGuard, RoleGuard)
  @Roles('brand_owner', 'brand_manager', 'admin', 'super_admin')
  submitProduct(@Param('id') id: string) {
    return this.productsService.submitProduct(id);
  }

  @Patch(':id/review')
  @UseGuards(AuthGuard, RoleGuard)
  @Roles('admin', 'super_admin')
  reviewProduct(@Param('id') id: string, @Body() body: ReviewProductDto) {
    return this.productsService.reviewProduct(id, body);
  }

  @Get(':id/public')
  async getPublicProduct(@Param('id') id: string) {
    const detail = await this.products.findById(id);
    const dto = detail ? this.productsService.toPublicProduct(detail) : null;
    if (!dto) {
      throw new NotFoundException('Public product not found');
    }
    return dto;
  }
}
