import { Body, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AdminAuditService } from '../../admin-audit/application/admin-audit.service';
import { CurrentUser } from '../../../shared/presentation/decorators/current-user.decorator';
import { Roles } from '../../../shared/presentation/decorators/roles.decorator';
import { AuthGuard } from '../../../shared/presentation/guards/auth.guard';
import { RoleGuard } from '../../../shared/presentation/guards/role.guard';
import type { AuthenticatedUser } from '../../identity/domain/user.types';
import { ProductsService } from '../application/products.service';
import { CreateProductDto, ProductVersionDto, ReviewProductDto, UpdateProductDto, UpdateProductStockDto } from '../application/dto/product.dto';
import { PRODUCT_CURRENCY_METADATA, PRODUCT_WRITE_ROLES, PRODUCT_ADMIN_ROLES, PRODUCT_SELECTION } from '../domain/product-contract';

const productRoutes = {root: 'products', creation: 'creation-requests/:requestId', requestId: 'requestId', brandId: 'brandId', metadata: 'metadata', private: ':id/private', id: 'id',
  product: ':id', stock: ':id/stock', archive: ':id/archive', restore: ':id/restore', submit: ':id/submit', review: ':id/review', public: ':id/public'} as const;

@Controller(productRoutes.root)
export class ProductsController {
  constructor(
    @Inject(ProductsService) private readonly productsService: ProductsService,
    @Inject(AdminAuditService) private readonly adminAuditService: AdminAuditService
  ) {}

  @Post()
  @UseGuards(AuthGuard, RoleGuard)
  @Roles(...PRODUCT_WRITE_ROLES)
  createProduct(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateProductDto) {
    return this.productsService.createProduct(user, body);
  }

  @Patch(productRoutes.submit)
  @UseGuards(AuthGuard, RoleGuard)
  @Roles(...PRODUCT_WRITE_ROLES)
  submitProduct(@CurrentUser() user: AuthenticatedUser, @Param(productRoutes.id, ParseUUIDPipe) id: string, @Body() body: ProductVersionDto) {
    return this.productsService.submitProduct(user, id, body);
  }


  @Get(PRODUCT_SELECTION.route)
  @UseGuards(AuthGuard, RoleGuard)
  @Roles(...PRODUCT_SELECTION.roles)
  selectProducts(@Query() query: Record<string, unknown>) { return this.productsService.selectProducts(query); }

  @Get(productRoutes.metadata)
  @UseGuards(AuthGuard, RoleGuard)
  @Roles(...PRODUCT_WRITE_ROLES)
  getMetadata() { return {currencies: PRODUCT_CURRENCY_METADATA}; }

  @Get()
  @UseGuards(AuthGuard, RoleGuard)
  @Roles(...PRODUCT_WRITE_ROLES)
  listProducts(@CurrentUser() user: AuthenticatedUser, @Query() query: Record<string, unknown>) {
    return this.productsService.listProducts(user, query);
  }

  @Get(productRoutes.creation)
  @UseGuards(AuthGuard, RoleGuard)
  @Roles(...PRODUCT_WRITE_ROLES)
  recoverCreation(@CurrentUser() user: AuthenticatedUser, @Param(productRoutes.requestId, ParseUUIDPipe) requestId: string,
    @Query(productRoutes.brandId, ParseUUIDPipe) brandId: string) {
    return this.productsService.recoverCreation(user, brandId, requestId);
  }

  @Get(productRoutes.private)
  @UseGuards(AuthGuard, RoleGuard)
  @Roles(...PRODUCT_WRITE_ROLES)
  getManagedProduct(@CurrentUser() user: AuthenticatedUser, @Param(productRoutes.id, ParseUUIDPipe) id: string) {
    return this.productsService.getManagedProduct(user, id);
  }

  @Put(productRoutes.product)
  @UseGuards(AuthGuard, RoleGuard)
  @Roles(...PRODUCT_WRITE_ROLES)
  updateProduct(@CurrentUser() user: AuthenticatedUser, @Param(productRoutes.id, ParseUUIDPipe) id: string, @Body() body: UpdateProductDto) {
    return this.productsService.updateProduct(user, id, body);
  }

  @Patch(productRoutes.stock)
  @UseGuards(AuthGuard, RoleGuard)
  @Roles(...PRODUCT_WRITE_ROLES)
  updateStock(@CurrentUser() user: AuthenticatedUser, @Param(productRoutes.id, ParseUUIDPipe) id: string, @Body() body: UpdateProductStockDto) {
    return this.productsService.updateStock(user, id, body);
  }

  @Patch(productRoutes.archive)
  @UseGuards(AuthGuard, RoleGuard)
  @Roles(...PRODUCT_WRITE_ROLES)
  archiveProduct(@CurrentUser() user: AuthenticatedUser, @Param(productRoutes.id, ParseUUIDPipe) id: string, @Body() body: ProductVersionDto) {
    return this.productsService.archiveProduct(user, id, body);
  }

  @Patch(productRoutes.restore)
  @UseGuards(AuthGuard, RoleGuard)
  @Roles(...PRODUCT_WRITE_ROLES)
  restoreProduct(@CurrentUser() user: AuthenticatedUser, @Param(productRoutes.id, ParseUUIDPipe) id: string, @Body() body: ProductVersionDto) {
    return this.productsService.restoreProduct(user, id, body);
  }

  @Patch(productRoutes.review)
  @UseGuards(AuthGuard, RoleGuard)
  @Roles(...PRODUCT_ADMIN_ROLES)
  async reviewProduct(@CurrentUser() user: AuthenticatedUser, @Param(productRoutes.id, ParseUUIDPipe) id: string, @Body() body: ReviewProductDto) {
    const detail = await this.productsService.reviewProduct(id, { ...body, reviewerId: user.id });
    await this.adminAuditService.record({
      adminUserId: user.id,
      action: 'product.reviewed',
      targetType: 'product',
      targetId: id,
      payload: {
        decision: body.decision,
        rejectionReason: body.rejectionReason ?? null
      }
    });
    return detail;
  }

  @Get(productRoutes.public)
  async getPublicProduct(@Param(productRoutes.id, ParseUUIDPipe) id: string) {
    const dto = await this.productsService.getPublicProduct(id);
    if (!dto) {
      throw new NotFoundException('Public product not found');
    }
    return dto;
  }
}
