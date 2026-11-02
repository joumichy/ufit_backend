import 'reflect-metadata';
import {randomUUID} from 'node:crypto';
import {plainToInstance} from 'class-transformer';
import {validate} from 'class-validator';
import {BadRequestException} from '@nestjs/common';
import {describe,expect,it,vi} from 'vitest';
import {PROFILE_IMAGE as P,profileImageSelection,profileImageUpload} from '../../src/modules/media/domain/profile-image.contract';
import {ProfileImageService} from '../../src/modules/media/application/profile-image.service';
import {DrizzleProfileMediaRepository} from '../../src/modules/media/infrastructure/drizzle-profile-media.repository';
import {MediaAssetLocator} from '../../src/modules/media/application/media-asset-locator';
import {UpdateMeRequest} from '../../src/modules/identity/presentation/dto/update-me.request';
import {UpdateCreatorProfileRequest} from '../../src/modules/creators/dto/update-creator-profile.request';
import {IMAGE_UPLOAD} from '../../src/modules/media/domain/image-upload.contract';
const F={origin:'https://media.example.invalid',external:'https://example.invalid/photo.jpg',unsupported:'outfit',
  decimalVersion:0.5,negativeVersion:-1,invalidID:'missing',imageField:'avatarUrl',
  validation:{whitelist:true,forbidNonWhitelisted:true}} as const;
describe('profile image command contracts',()=>{
  it('accepts each explicit owner and normalizes UUID casing',()=>{
    for(const kind of Object.values(P.kind)){
      const ownerId=randomUUID(),requestId=randomUUID();
      expect(profileImageUpload.parse({kind,ownerId:ownerId.toUpperCase(),requestId:requestId.toUpperCase()})).toEqual({kind,ownerId,requestId});
    }
  });
  it('requires exactly one canonical owner shape and an upload request identity',()=>{
    const valid={kind:P.kind.account,ownerId:randomUUID(),requestId:randomUUID()};
    for(const invalid of [{...valid,kind:F.unsupported},{...valid,ownerId:F.invalidID},{kind:valid.kind,ownerId:valid.ownerId},
      {...valid,userId:valid.ownerId},{...valid,creatorId:valid.ownerId},{...valid,requestId:null}]){
      expect(profileImageUpload.safeParse(invalid).success).toBe(false);
    }
  });
  it('requires explicit null for removal and accepts an owned asset reference candidate',()=>{
    const requestId=randomUUID();
    expect(profileImageSelection.parse({requestId,expectedVersion:P.limits.initialVersion,assetId:null})).toEqual({requestId,expectedVersion:P.limits.initialVersion,assetId:null});
    const assetId=randomUUID();expect(profileImageSelection.parse({requestId,expectedVersion:P.limits.initialVersion,assetId}).assetId).toBe(assetId);
  });
  it('rejects missing, fractional, overflowing, URL and alias representations',()=>{
    const valid={requestId:randomUUID(),expectedVersion:P.limits.initialVersion,assetId:randomUUID()};
    for(const invalid of [{...valid,expectedVersion:null},{...valid,expectedVersion:F.decimalVersion},{...valid,expectedVersion:F.negativeVersion},
      {...valid,expectedVersion:P.limits.maxVersion},{requestId:valid.requestId,expectedVersion:valid.expectedVersion},
      {...valid,assetId:F.external},{...valid,url:F.external},{...valid,version:P.limits.initialVersion}]){
      expect(profileImageSelection.safeParse(invalid).success).toBe(false);
    }
  });
  it('rejects invalid commands before a repository side effect',async()=>{
    const repository=Object.create(DrizzleProfileMediaRepository.prototype) as DrizzleProfileMediaRepository;
    const select=vi.fn();repository.select=select;
    const service=new ProfileImageService(repository,{uploadOrVerify:vi.fn(),sign:vi.fn()},new MediaAssetLocator(()=>F.origin,P));
    await expect(service.select(randomUUID(),{kind:P.kind.account,ownerId:randomUUID()},{})).rejects.toBeInstanceOf(BadRequestException);
    expect(select).not.toHaveBeenCalled();
  });
  it('rejects invalid files before reserving storage ownership',async()=>{
    const repository=Object.create(DrizzleProfileMediaRepository.prototype) as DrizzleProfileMediaRepository;
    const reserve=vi.fn();repository.reserve=reserve;
    const service=new ProfileImageService(repository,{uploadOrVerify:vi.fn(),sign:vi.fn()},new MediaAssetLocator(()=>F.origin,P));
    const input={kind:P.kind.account,ownerId:randomUUID(),requestId:randomUUID()};
    await expect(service.upload(randomUUID(),input)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.upload(randomUUID(),input,{buffer:Buffer.alloc(P.limits.zero),mimetype:IMAGE_UPLOAD.mime,size:P.limits.zero})).rejects.toBeInstanceOf(BadRequestException);
    expect(reserve).not.toHaveBeenCalled();
  });
  it('prevents text PATCH requests from bypassing image ownership and version checks',async()=>{
    for(const Request of [UpdateMeRequest,UpdateCreatorProfileRequest]){
      expect((await validate(plainToInstance(Request,{[F.imageField]:F.external}),F.validation)).length).toBeGreaterThan(P.limits.zero);
    }
  });
});
