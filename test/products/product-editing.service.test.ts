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
function edit(detail:Pick<ProductDetail,'variants'|'images'> & {product:Omit<ProductDetail['product'],'reviewedBy'|'reviewedAt'|'rejectionReason'>}){return{name:detail.product.name,description:detail.product.description,category:detail.product.category,basePrice:detail.product.basePrice,currency:detail.product.currency,
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
  await expect(service.publishProduct(productFixture.actor,first.product.id,{expectedVersion:first.product.version})).rejects.toBeInstanceOf(ForbiddenException);
  await expect(service.listProducts(productFixture.actor,{})).rejects.toBeInstanceOf(BadRequestException);
 });
 it('rejects a stale content version and never silently removes a variant identity',async()=>{
  const{service}=setup();const first=await service.createProduct(productFixture.actor,create());
  await expect(service.updateProduct(productFixture.actor,first.product.id,{...edit(first),expectedVersion:productFixture.invalidVersion})).rejects.toBeInstanceOf(ConflictException);
  await expect(service.updateProduct(productFixture.actor,first.product.id,{...edit(first),variants:[]})).rejects.toBeInstanceOf(BadRequestException);
 });
 it('keeps approved stock changes published and returns content revisions to draft',async()=>{
  const{service}=setup();const first=await service.createProduct(productFixture.actor,create());const published=await service.publishProduct(productFixture.actor,first.product.id,{expectedVersion:first.product.version});
  const variant=published.variants[productFixture.firstIndex];const stocked=await service.updateStock(productFixture.actor,published.product.id,{expectedVersion:published.product.version,variantId:variant.id,expectedStockQuantity:variant.stockQuantity,stockQuantity:productFixture.restockQuantity});
  expect(stocked.product.status).toBe(PRODUCT_STATUS.active);const revised=await service.updateProduct(productFixture.actor,stocked.product.id,{...edit(stocked),name:productFixture.revisedName});
  expect(revised.product.status).toBe(PRODUCT_STATUS.draft);expect(revised.variants[productFixture.firstIndex].id).toBe(variant.id);expect(revised.images[productFixture.firstIndex].id).toBe(first.images[productFixture.firstIndex].id);
 });
 it('rolls back content and revision when a sale changed the expected stock',async()=>{
  const{service,repository}=setup();const first=await service.createProduct(productFixture.actor,create());const stale=edit(first);repository.variants[productFixture.firstIndex].stockQuantity--;
  await expect(service.updateProduct(productFixture.actor,first.product.id,{...stale,name:productFixture.rollbackName})).rejects.toBeInstanceOf(ConflictException);
  const current=await service.getManagedProduct(productFixture.actor,first.product.id);expect(current.product.name).toBe(first.product.name);expect(current.product.version).toBe(first.product.version);
 });
 it('requires complete products and an active brand, without content approval',async()=>{
  const{service,repository}=setup();const first=await service.createProduct(productFixture.actor,{...create(),images:[]});
  await expect(service.publishProduct(productFixture.actor,first.product.id,{expectedVersion:first.product.version})).rejects.toBeInstanceOf(BadRequestException);
  const archived=await service.archiveProduct(productFixture.actor,first.product.id,{expectedVersion:first.product.version});
  const restored=await service.restoreProduct(productFixture.actor,first.product.id,{expectedVersion:archived.product.version});
  expect(restored.product.status).toBe(PRODUCT_STATUS.draft);
  const ready=await service.createProduct(productFixture.actor,create());repository.brands.get(productFixture.brandID)!.status=PROFILE_STATUS.paused;
  await expect(service.publishProduct(productFixture.actor,ready.product.id,{expectedVersion:ready.product.version})).rejects.toBeInstanceOf(ForbiddenException);
  repository.brands.get(productFixture.brandID)!.status=PROFILE_STATUS.active;
  const published=await service.publishProduct(productFixture.actor,ready.product.id,{expectedVersion:ready.product.version});
  expect(published.product.status).toBe(PRODUCT_STATUS.active);expect(published.product).not.toHaveProperty('reviewedAt');
  const withdrawn=await service.withdrawProduct(productFixture.actor,ready.product.id,{expectedVersion:published.product.version});
  expect(withdrawn.product.status).toBe(PRODUCT_STATUS.draft);
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

 it('keeps a draft private if image read links cannot be prepared before publication',async()=>{
  const{service,repository,media}=setup();const first=await service.createProduct(productFixture.actor,create());
  media.failReads=true;
  await expect(service.publishProduct(productFixture.actor,first.product.id,{expectedVersion:first.product.version})).rejects.toBeInstanceOf(ServiceUnavailableException);
  const current=await repository.findById(first.product.id);expect(current?.product.version).toBe(first.product.version);expect(current?.product.status).toBe(PRODUCT_STATUS.draft);
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
