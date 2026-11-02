import {Body,Controller,Get,Inject,Param,ParseUUIDPipe,Post,Put,Res,UploadedFile,UseGuards,UseInterceptors} from '@nestjs/common';
import {FileInterceptor} from '@nestjs/platform-express';
import {IsIn,IsUUID} from 'class-validator';
import type {Response} from 'express';
import {CurrentUser} from '../../../shared/presentation/decorators/current-user.decorator';
import {AuthGuard} from '../../../shared/presentation/guards/auth.guard';
import type {AuthenticatedUser} from '../../identity/domain/user.types';
import {PROFILE_IMAGE as P} from '../domain/profile-image.contract';
import type {ImageUploadFile} from '../domain/image-upload.contract';
import {ProfileImageService} from '../application/profile-image.service';
class ProfileUploadDto {
  @IsIn(Object.values(P.kind)) kind!:string;
  @IsUUID() ownerId!:string;
  @IsUUID() requestId!:string;
}
@Controller(P.routes.root)
export class ProfileImageController {
  constructor(@Inject(ProfileImageService) private readonly images:ProfileImageService) {}
  @Post(P.routes.upload) @UseGuards(AuthGuard)
  @UseInterceptors(FileInterceptor(P.multipart.file,{limits:{fileSize:P.maxBytes,files:P.multipart.files,fields:P.multipart.fields}}))
  upload(@CurrentUser() user:AuthenticatedUser,@Body() body:ProfileUploadDto,@UploadedFile() file?:ImageUploadFile){
    return this.images.upload(user.id,body,file);
  }
  @Get(P.routes.selection) @UseGuards(AuthGuard)
  read(@CurrentUser() user:AuthenticatedUser,@Param(P.routes.kind) kind:string,@Param(P.routes.ownerId,ParseUUIDPipe) ownerId:string){
    return this.images.read(user.id,{kind,ownerId});
  }
  @Put(P.routes.selection) @UseGuards(AuthGuard)
  select(@CurrentUser() user:AuthenticatedUser,@Param(P.routes.kind) kind:string,@Param(P.routes.ownerId,ParseUUIDPipe) ownerId:string,@Body() body:unknown){
    return this.images.select(user.id,{kind,ownerId},body);
  }
  @Get(P.routes.private) @UseGuards(AuthGuard)
  privateImage(@CurrentUser() user:AuthenticatedUser,@Param(P.routes.id,ParseUUIDPipe) id:string){return this.images.privateImage(user.id,id);}
  @Get(P.routes.image)
  async image(@Param(P.routes.id,ParseUUIDPipe) id:string,@Res() response:Response):Promise<void>{response.redirect(await this.images.publicImage(id));}
}
