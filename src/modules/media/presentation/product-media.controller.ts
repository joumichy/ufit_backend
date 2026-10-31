import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsUUID } from 'class-validator';
import type { Response } from 'express';
import { CurrentUser } from '../../../shared/presentation/decorators/current-user.decorator';
import { Roles } from '../../../shared/presentation/decorators/roles.decorator';
import { AuthGuard } from '../../../shared/presentation/guards/auth.guard';
import { RoleGuard } from '../../../shared/presentation/guards/role.guard';
import type { AuthenticatedUser } from '../../identity/domain/user.types';
import { PRODUCT_WRITE_ROLES } from '../../products/domain/product-contract';
import { ProductMediaService, type ProductImageFile } from '../application/product-media.service';
import { PRODUCT_MEDIA } from '../domain/product-media.contract';

class ProductUploadDto { @IsUUID() brandId!: string; @IsUUID() requestId!: string; }
@Controller(PRODUCT_MEDIA.routes.root)
export class ProductMediaController {
  constructor(@Inject(ProductMediaService) private readonly media: ProductMediaService) {}
  @Post(PRODUCT_MEDIA.routes.upload)
  @UseGuards(AuthGuard, RoleGuard)
  @Roles(...PRODUCT_WRITE_ROLES)
  @UseInterceptors(FileInterceptor(PRODUCT_MEDIA.multipart.file, {limits: {
    fileSize: PRODUCT_MEDIA.maxBytes, files: PRODUCT_MEDIA.multipart.files, fields: PRODUCT_MEDIA.multipart.fields,
  }}))
  upload(@CurrentUser() user: AuthenticatedUser, @Body() body: ProductUploadDto, @UploadedFile() file?: ProductImageFile) {
    return this.media.upload(user.id, body, file);
  }
  @Get(PRODUCT_MEDIA.routes.image)
  async image(@Param(PRODUCT_MEDIA.routes.id, ParseUUIDPipe) id: string, @Res() response: Response): Promise<void> {
    response.redirect(await this.media.publicImage(id));
  }
}
