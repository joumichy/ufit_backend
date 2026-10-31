import 'reflect-metadata';
import {randomUUID} from 'node:crypto';
import {plainToInstance} from 'class-transformer';
import {validate} from 'class-validator';
import {describe,expect,it} from 'vitest';
import {CreateProductDto,ReviewProductDto,UpdateProductDto,UpdateProductStockDto} from '../../src/modules/products/application/dto/product.dto';
import {PRODUCT_EDITING,PRODUCT_CURRENCY_METADATA,PRODUCT_STATUS} from '../../src/modules/products/domain/product-contract';
import {productFixture} from './memory-product.repository';
const validationCase={noErrors:0, padding:'  ', negative:-1, overflowStep:1, validVersion:1, invalidVersion:0, forgedSlug:'forged', unknownCurrency:'ZZZ'} as const;
const currencyExamples=[{code:'CHF',digits:2},{code:'JPY',digits:0},{code:'BHD',digits:3}] as const;
const options={whitelist:true,forbidNonWhitelisted:true};
const payload=()=>({brandId:productFixture.brandID,requestId:randomUUID(),name:productFixture.name,description:productFixture.description,category:productFixture.category,basePrice:productFixture.basePrice,currency:productFixture.currency,
  variants:[{sku:productFixture.skuPrefix+randomUUID(),stockQuantity:productFixture.stock}],images:[productFixture.image]});
describe('product editing input contracts',()=>{
 it('accepts the exact canonical create shape and trims optional text',async()=>{
  const input=plainToInstance(CreateProductDto,{...payload(),name:validationCase.padding+productFixture.name+validationCase.padding,material:validationCase.padding,careInstructions:null});
  expect(await validate(input,options)).toHaveLength(validationCase.noErrors);expect(input.name).toBe(productFixture.name);expect(input.material).toBeNull();expect(input.careInstructions).toBeNull();
 });
 it('rejects caller-supplied state, actor, slug and nullable required collections',async()=>{
  for(const extra of [{status:PRODUCT_STATUS.active},{reviewedBy:randomUUID()},{slug:validationCase.forgedSlug},{userId:randomUUID()},{variants:null},{images:null},{variants:[null]},{images:[null]}])
   expect((await validate(plainToInstance(CreateProductDto,{...payload(),...extra}),options)).length).toBeGreaterThan(validationCase.noErrors);
 });
 it('requires unique SKUs after trimming and unique image positions',async()=>{
  const body=payload();for(const extra of [{variants:[body.variants[productFixture.firstIndex],{...body.variants[productFixture.firstIndex],sku:body.variants[productFixture.firstIndex].sku+validationCase.padding}]},{images:[body.images[productFixture.firstIndex],body.images[productFixture.firstIndex]]}])
   expect((await validate(plainToInstance(CreateProductDto,{...body,...extra}),options)).length).toBeGreaterThan(validationCase.noErrors);
 });
 it('bounds database integers and accepts only supported canonical currency codes',async()=>{
  for(const extra of [{basePrice:validationCase.negative},{basePrice:PRODUCT_EDITING.limits.integerMax+validationCase.overflowStep},{currency:validationCase.unknownCurrency},{currency:productFixture.currency.toLowerCase()}])
   expect((await validate(plainToInstance(CreateProductDto,{...payload(),...extra}),options)).length).toBeGreaterThan(validationCase.noErrors);
  for(const example of currencyExamples)expect(PRODUCT_CURRENCY_METADATA.find(row=>row.code===example.code)?.minorUnitDigits).toBe(example.digits);
 });
 it('does not accept a public reviewer identifier and requires a version',async()=>{
  for(const input of [{decision:PRODUCT_STATUS.active},{decision:PRODUCT_STATUS.active,expectedVersion:validationCase.validVersion,reviewerId:randomUUID()},{decision:PRODUCT_STATUS.active,expectedVersion:null},{decision:PRODUCT_STATUS.active,expectedVersion:validationCase.invalidVersion}])
   expect((await validate(plainToInstance(ReviewProductDto,input),options)).length).toBeGreaterThan(validationCase.noErrors);
 });
 it('requires explicit stock preconditions and rejects null retained identifiers',async()=>{
  expect((await validate(plainToInstance(UpdateProductStockDto,{expectedVersion:validationCase.validVersion,variantId:randomUUID(),stockQuantity:productFixture.restockQuantity}),options)).length).toBeGreaterThan(validationCase.noErrors);
  const {requestId,brandId,...fields}=payload();
  expect((await validate(plainToInstance(UpdateProductDto,{...fields,expectedVersion:validationCase.validVersion,variants:[{...fields.variants[productFixture.firstIndex],id:null,status:PRODUCT_STATUS.active}]}),options)).length).toBeGreaterThan(validationCase.noErrors);
 });
});
