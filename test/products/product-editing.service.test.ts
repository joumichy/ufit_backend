import {randomUUID} from 'node:crypto';
import {BadRequestException,ConflictException,ForbiddenException} from '@nestjs/common';
import {describe,expect,it} from 'vitest';
import {PRODUCT_STATUS} from '../../src/modules/products/domain/product-contract';
import {ProductsService} from '../../src/modules/products/application/products.service';
import type {ProductDetail} from '../../src/modules/products/domain/product.types';
import {MemoryProductRepository,productFixture} from './memory-product.repository';
function setup(){const repository=new MemoryProductRepository();return{repository,service:new ProductsService(repository)};}
const create=()=>({brandId:productFixture.brandID,requestId:randomUUID(),name:productFixture.name,description:productFixture.description,category:productFixture.category,basePrice:productFixture.basePrice,currency:productFixture.currency,
 variants:[{sku:productFixture.skuPrefix+randomUUID(),stockQuantity:productFixture.stock}],images:[productFixture.image]});
function edit(detail:ProductDetail){return{name:detail.product.name,description:detail.product.description,category:detail.product.category,basePrice:detail.product.basePrice,currency:detail.product.currency,
 expectedVersion:detail.product.version,variants:detail.variants.map(({id,size,color,sku,stockQuantity,priceOverride,status})=>({id,size,color,sku,stockQuantity,priceOverride,status,expectedStockQuantity:stockQuantity})),images:detail.images.map(({id,url,position,kind})=>({id,url,position,kind}))};}
describe('owned product lifecycle',()=>{
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

});
