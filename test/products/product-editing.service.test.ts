import {randomUUID} from 'node:crypto';
import {BadRequestException,ConflictException,ForbiddenException,ServiceUnavailableException} from '@nestjs/common';
import {describe,expect,it} from 'vitest';
import {PRODUCT_STATUS} from '../../src/modules/products/domain/product-contract';
import {ProductsService} from '../../src/modules/products/application/products.service';
import type {ProductDetail} from '../../src/modules/products/domain/product.types';
import {MemoryProductRepository,productFixture} from './memory-product.repository';
import {MemoryProductMediaReader,mediaReaderFixture} from './memory-product-media.reader';
import {PROFILE_STATUS} from '../../src/shared/domain/profile-editing.contract';
function setup(){const repository=new MemoryProductRepository();const media=new MemoryProductMediaReader();return{repository,media,service:new ProductsService(repository,media)};}
const create=()=>({brandId:productFixture.brandID,requestId:randomUUID(),name:productFixture.name,description:productFixture.description,category:productFixture.category,basePrice:productFixture.basePrice,currency:productFixture.currency,
 variants:[{sku:productFixture.skuPrefix+randomUUID(),stockQuantity:productFixture.stock}],images:[productFixture.image]});
function edit(detail:ProductDetail){return{name:detail.product.name,description:detail.product.description,category:detail.product.category,basePrice:detail.product.basePrice,currency:detail.product.currency,
 expectedVersion:detail.product.version,variants:detail.variants.map(({id,size,color,sku,stockQuantity,priceOverride,status})=>({id,size,color,sku,stockQuantity,priceOverride,status,expectedStockQuantity:stockQuantity})),images:detail.images.map(({id,url,position,kind})=>({id,url,position,kind}))};}
describe('owned product lifecycle',()=>{
 it('returns the authoritative brand context in private detail, queue and creation recovery',async()=>{
  const{service,repository}=setup(),body=create(),created=await service.createProduct(productFixture.actor,body);
  const brand={id:productFixture.brandID,brandName:productFixture.brandName,status:PROFILE_STATUS.paused};
  repository.brands.set(brand.id,brand);
  const moderator={id:productFixture.adminID,roles:[...productFixture.adminRoles]};
  expect((await service.getManagedProduct(moderator,created.product.id)).brand).toEqual(brand);
  expect((await service.listProducts(moderator,{})).items[productFixture.firstIndex].brand).toEqual(brand);
  expect((await service.recoverCreation(productFixture.actor,body.brandId,body.requestId)).brand).toEqual(brand);
 });
 it('reuses a creation key for the same payload and refuses a changed payload',async()=>{
  const{service,repository}=setup(),body=create();const first=await service.createProduct(productFixture.actor,body);const replay=await service.createProduct(productFixture.actor,body);
  expect(replay.product.id).toBe(first.product.id);expect(repository.products.size).toBe(productFixture.createdProductCount);
  await expect(service.createProduct(productFixture.actor,{...body,name:productFixture.changedName})).rejects.toBeInstanceOf(ConflictException);
 });
 it('requires a real membership for every write and denies unscoped non-admin lists',async()=>{
  const{service,repository}=setup(),body=create();const first=await service.createProduct(productFixture.actor,body);repository.members.clear();
  await expect(service.createProduct(productFixture.actor,{...body,requestId:randomUUID()})).rejects.toBeInstanceOf(ForbiddenException);
  await expect(service.submitProduct(productFixture.actor,first.product.id,{expectedVersion:first.product.version})).rejects.toBeInstanceOf(ForbiddenException);
  await expect(service.listProducts(productFixture.actor,{})).rejects.toBeInstanceOf(BadRequestException);
 });
 it('rejects a stale content version and never silently removes a variant identity',async()=>{
  const{service}=setup();const first=await service.createProduct(productFixture.actor,create());
  await expect(service.updateProduct(productFixture.actor,first.product.id,{...edit(first),expectedVersion:productFixture.invalidVersion})).rejects.toBeInstanceOf(ConflictException);
  await expect(service.updateProduct(productFixture.actor,first.product.id,{...edit(first),variants:[]})).rejects.toBeInstanceOf(BadRequestException);
 });
 it('keeps approved stock changes published and returns content revisions to draft',async()=>{
  const{service}=setup();const first=await service.createProduct(productFixture.actor,create());const submitted=await service.submitProduct(productFixture.actor,first.product.id,{expectedVersion:first.product.version});
  const approved=await service.reviewProduct(first.product.id,{expectedVersion:submitted.product.version,reviewerId:productFixture.adminID,decision:PRODUCT_STATUS.active});
  const variant=approved.variants[productFixture.firstIndex];const stocked=await service.updateStock(productFixture.actor,approved.product.id,{expectedVersion:approved.product.version,variantId:variant.id,expectedStockQuantity:variant.stockQuantity,stockQuantity:productFixture.restockQuantity});
  expect(stocked.product.status).toBe(PRODUCT_STATUS.active);const revised=await service.updateProduct(productFixture.actor,stocked.product.id,{...edit(stocked),name:productFixture.revisedName});
  expect(revised.product.status).toBe(PRODUCT_STATUS.draft);expect(revised.variants[productFixture.firstIndex].id).toBe(variant.id);expect(revised.images[productFixture.firstIndex].id).toBe(first.images[productFixture.firstIndex].id);
 });
 it('rolls back content and revision when a sale changed the expected stock',async()=>{
  const{service,repository}=setup();const first=await service.createProduct(productFixture.actor,create());const stale=edit(first);repository.variants[productFixture.firstIndex].stockQuantity--;
  await expect(service.updateProduct(productFixture.actor,first.product.id,{...stale,name:productFixture.rollbackName})).rejects.toBeInstanceOf(ConflictException);
  const current=await service.getManagedProduct(productFixture.actor,first.product.id);expect(current.product.name).toBe(first.product.name);expect(current.product.version).toBe(first.product.version);
 });
 it('requires complete submission, a motivated refusal and a new review after restore',async()=>{
  const{service}=setup();const first=await service.createProduct(productFixture.actor,{...create(),images:[]});
  await expect(service.submitProduct(productFixture.actor,first.product.id,{expectedVersion:first.product.version})).rejects.toBeInstanceOf(BadRequestException);
  const archived=await service.archiveProduct(productFixture.actor,first.product.id,{expectedVersion:first.product.version});const restored=await service.restoreProduct(productFixture.actor,first.product.id,{expectedVersion:archived.product.version});
  expect(restored.product.status).toBe(PRODUCT_STATUS.draft);expect(restored.product.version).toBeGreaterThan(archived.product.version);
  const ready=await service.createProduct(productFixture.actor,create());const submitted=await service.submitProduct(productFixture.actor,ready.product.id,{expectedVersion:ready.product.version});
  await expect(service.reviewProduct(ready.product.id,{expectedVersion:submitted.product.version,reviewerId:productFixture.adminID,decision:PRODUCT_STATUS.rejected})).rejects.toBeInstanceOf(BadRequestException);
 });
 it('allows moderation to archive and restore without granting content or stock ownership',async()=>{
  const{service}=setup();const first=await service.createProduct(productFixture.actor,create());const moderator={id:productFixture.adminID,roles:['admin'] as const};
  const actor={...moderator,roles:[...moderator.roles]};
  await expect(service.updateProduct(actor,first.product.id,edit(first))).rejects.toBeInstanceOf(ForbiddenException);
  const archived=await service.archiveProduct(actor,first.product.id,{expectedVersion:first.product.version});expect(archived.product.status).toBe(PRODUCT_STATUS.archived);
  const restored=await service.restoreProduct(actor,first.product.id,{expectedVersion:archived.product.version});expect(restored.product.status).toBe(PRODUCT_STATUS.draft);
 });

 it('recovers the canonical created resource from the scoped request key',async()=>{
  const{service,repository}=setup(),body=create();const first=await service.createProduct(productFixture.actor,body);
  const recovered=await service.recoverCreation(productFixture.actor,body.brandId,body.requestId);expect(recovered.product.id).toBe(first.product.id);
  repository.members.clear();await expect(service.recoverCreation(productFixture.actor,body.brandId,body.requestId)).rejects.toBeInstanceOf(ForbiddenException);
 });

 it('leaves moderation unchanged when image read links cannot be prepared',async()=>{
  const{service,repository,media}=setup();const first=await service.createProduct(productFixture.actor,create());
  const submitted=await service.submitProduct(productFixture.actor,first.product.id,{expectedVersion:first.product.version});
  media.failReads=true;
  await expect(service.reviewProduct(first.product.id,{expectedVersion:submitted.product.version,decision:PRODUCT_STATUS.active,reviewerId:productFixture.adminID})).rejects.toBeInstanceOf(ServiceUnavailableException);
  const current=await repository.findById(first.product.id);expect(current?.product.version).toBe(submitted.product.version);expect(current?.product.status).toBe(PRODUCT_STATUS.underReview);
 });
 it('attaches only ready media of the product brand and persists stable URLs separately from read URLs',async()=>{
  const{service,repository,media}=setup(),body=create(),assetID=randomUUID();
  const url=media.locator.url(assetID),image={...productFixture.image,url};
  await expect(service.createProduct(productFixture.actor,{...body,images:[image]})).rejects.toBeInstanceOf(BadRequestException);
  expect(repository.products.size).toBe(productFixture.invalidVersion);
  repository.readyMedia.set(assetID,randomUUID());
  await expect(service.createProduct(productFixture.actor,{...body,images:[image]})).rejects.toBeInstanceOf(BadRequestException);
  repository.readyMedia.set(assetID,body.brandId);media.assets.set(assetID,{brandId:body.brandId,displayUrl:mediaReaderFixture.signedOrigin+assetID});
  const created=await service.createProduct(productFixture.actor,{...body,images:[image]});
  expect(created.images[productFixture.firstIndex].url).toBe(url);
  expect(created.images[productFixture.firstIndex].displayUrl).toBe(mediaReaderFixture.signedOrigin+assetID);
  expect(repository.images[productFixture.firstIndex]).not.toHaveProperty('displayUrl');
  const foreignID=randomUUID();repository.readyMedia.set(foreignID,randomUUID());
  await expect(service.updateProduct(productFixture.actor,created.product.id,{...edit(created),name:productFixture.rollbackName,images:[{...image,url:media.locator.url(foreignID)}]})).rejects.toBeInstanceOf(BadRequestException);
  expect((await service.getManagedProduct(productFixture.actor,created.product.id)).product.version).toBe(created.product.version);
 });
});
