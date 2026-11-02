import {randomUUID} from 'node:crypto';
import {BadRequestException,Inject,Injectable,NotFoundException,ServiceUnavailableException} from '@nestjs/common';
import {PROFILE_IMAGE as P,profileImageOwner,profileImageSelection,profileImageUpload,type ProfileImageOwner} from '../domain/profile-image.contract';
import type {ImageStorage,ImageUploadFile} from '../domain/image-upload.contract';
import {DrizzleProfileMediaRepository,type ProfileAsset,assetBelongsTo} from '../infrastructure/drizzle-profile-media.repository';
import {MediaAssetLocator} from './media-asset-locator';
import {prepareImageUpload} from './prepare-image-upload';
@Injectable()
export class ProfileImageService {
  constructor(@Inject(DrizzleProfileMediaRepository) private readonly repository:DrizzleProfileMediaRepository,
    @Inject(P.token.storage) private readonly storage:ImageStorage,
    @Inject(P.token.locator) private readonly locator:MediaAssetLocator) {}
  private owner(raw:unknown):ProfileImageOwner {
    const result=profileImageOwner.safeParse(raw);
    if(!result.success)throw new BadRequestException(P.failure.invalid);
    return result.data;
  }
  async read(actorId:string,raw:unknown) {
    const owner=this.owner(raw),state=await this.repository.read(owner,actorId);
    if(state.url===null)return {...owner,version:state.version,image:null};
    const id=this.locator.id(state.url);
    if(id===null)return {...owner,version:state.version,image:{id:null,url:state.url,displayUrl:state.url}};
    const asset=await this.repository.findOwnedReady(id,actorId);
    if(!asset || !assetBelongsTo(asset,owner))throw new NotFoundException(P.failure.missing);
    return {...owner,version:state.version,image:await this.present(asset)};
  }
  async select(actorId:string,raw:unknown,input:unknown) {
    const owner=this.owner(raw),command=profileImageSelection.safeParse(input);
    if(!command.success)throw new BadRequestException(P.failure.invalid);
    const url=command.data.assetId===null?null:this.locator.url(command.data.assetId);
    return this.repository.select(owner,actorId,command.data,url);
  }
  async upload(actorId:string,raw:unknown,file?:ImageUploadFile) {
    const parsed=profileImageUpload.safeParse(raw);
    if(!parsed.success)throw new BadRequestException(P.failure.invalid);
    const {requestId,...owner}=parsed.data,image=prepareImageUpload(file,P.failure.file),id=randomUUID();
    const asset=await this.repository.reserve(owner,{id,uploadedBy:actorId,requestId,fingerprint:image.fingerprint,
      byteSize:image.bytes.length,contentType:P.mime,
      objectPath:owner.kind+P.storageSettings.separator+owner.ownerId+P.storageSettings.separator+id+P.extension});
    if(asset.status!==P.status.ready)await this.storage.uploadOrVerify(asset.objectPath,image.bytes,asset.fingerprint);
    const ready=await this.repository.markReady(asset,actorId);
    return {...owner,...await this.present(ready)};
  }
  async privateImage(actorId:string,id:string) {
    const asset=await this.repository.findOwnedReady(id.toLowerCase(),actorId);
    if(!asset)throw new NotFoundException(P.failure.missing);
    return this.present(asset);
  }
  async publicImage(id:string):Promise<string> {
    const asset=await this.repository.findPublic(id.toLowerCase(),this.locator.url(id));
    if(!asset)throw new NotFoundException(P.failure.missing);
    return (await this.present(asset)).displayUrl;
  }
  private async present(asset:ProfileAsset) {
    const signed=await this.storage.sign([asset.objectPath]),displayUrl=signed.get(asset.objectPath);
    if(!displayUrl)throw new ServiceUnavailableException(P.failure.unavailable);
    return {id:asset.id,url:this.locator.url(asset.id),displayUrl};
  }
}
