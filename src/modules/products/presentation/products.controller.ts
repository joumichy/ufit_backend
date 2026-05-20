import { Body, Controller, Get, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { ProductsService } from '../application/products.service';
import { CreateProductDto, ReviewProductDto } from '../application/dto/product.dto';
import { PRODUCT_REPOSITORY, type ProductRepository } from '../domain/product.types';
import { Inject } from '@nestjs/common';

@Controller('products')
export class ProductsController {
  constructor(
    private readonly productsService: ProductsService,
    @Inject(PRODUCT_REPOSITORY) private readonly products: ProductRepository
  ) {}

  @Post()
  createProduct(@Body() body: CreateProductDto) {
    return this.productsService.createProduct(body);
  }

  @Patch(':id/submit')
  submitProduct(@Param('id') id: string) {
    return this.productsService.submitProduct(id);
  }

  @Patch(':id/review')
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
