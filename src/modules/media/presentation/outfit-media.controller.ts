import {Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Res, UploadedFile, UseGuards, UseInterceptors} from '@nestjs/common';
import {FileInterceptor} from '@nestjs/platform-express';
import {IsOptional, IsUUID} from 'class-validator';
import type {Response} from 'express';
import {CurrentUser} from '../../../shared/presentation/decorators/current-user.decorator';
import {Roles} from '../../../shared/presentation/decorators/roles.decorator';
import {AuthGuard} from '../../../shared/presentation/guards/auth.guard';
import {RoleGuard} from '../../../shared/presentation/guards/role.guard';
import type {AuthenticatedUser} from '../../identity/domain/user.types';
import {OUTFIT_WRITE_ROLES} from '../../outfits/domain/outfit-editing.contract';
import {OUTFIT_MEDIA} from '../domain/outfit-media.contract';
import type {ImageUploadFile} from '../domain/image-upload.contract';
import {OutfitMediaService} from '../application/outfit-media.service';

class OutfitUploadDto {
  @IsOptional() @IsUUID() creatorId?: string;
  @IsOptional() @IsUUID() brandId?: string;
  @IsUUID() requestId!: string;
}
@Controller(OUTFIT_MEDIA.routes.root)
export class OutfitMediaController {
  constructor(@Inject(OutfitMediaService) private readonly media: OutfitMediaService) {}
  @Post(OUTFIT_MEDIA.routes.upload)
  @UseGuards(AuthGuard, RoleGuard)
  @Roles(...OUTFIT_WRITE_ROLES)
  @UseInterceptors(FileInterceptor(OUTFIT_MEDIA.multipart.file, {limits: {fileSize: OUTFIT_MEDIA.maxBytes, files: OUTFIT_MEDIA.multipart.files, fields: OUTFIT_MEDIA.multipart.fields}}))
  upload(@CurrentUser() user: AuthenticatedUser, @Body() body: OutfitUploadDto, @UploadedFile() file?: ImageUploadFile) { return this.media.upload(user, body, file); }
  @Get(OUTFIT_MEDIA.routes.private)
  @UseGuards(AuthGuard, RoleGuard)
  @Roles(...OUTFIT_WRITE_ROLES)
  privateImage(@CurrentUser() user: AuthenticatedUser, @Param(OUTFIT_MEDIA.routes.id, ParseUUIDPipe) id: string) { return this.media.privateImage(user, id); }
  @Get(OUTFIT_MEDIA.routes.image)
  async image(@Param(OUTFIT_MEDIA.routes.id, ParseUUIDPipe) id: string, @Res() response: Response): Promise<void> { response.redirect(await this.media.publicImage(id)); }
}
