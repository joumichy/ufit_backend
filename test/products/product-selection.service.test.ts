import {randomUUID} from 'node:crypto';
import {BadRequestException} from '@nestjs/common';
import {describe, expect, it} from 'vitest';
import {ProductsService} from '../../src/modules/products/application/products.service';
import {PRODUCT_EDITING, PRODUCT_STATUS} from '../../src/modules/products/domain/product-contract';
import {PROFILE_STATUS} from '../../src/shared/domain/profile-editing.contract';
import {MemoryProductRepository, productFixture} from './memory-product.repository';
import {MemoryProductMediaReader} from './memory-product-media.reader';
const data = {first: 'Chemise 100%', second: 'Veste de travail', draft: 'Produit privé', euro: 'EUR', pageSize: 1, total: 2, none: 0,
  percent: '%', underscore: '_', search: 'CHEMISE', blank: '  ', invalidCursor: 'invalid', price: 15000} as const;
async function setup() {
  const repository = new MemoryProductRepository(), service = new ProductsService(repository, new MemoryProductMediaReader());
  async function create(name: string, currency: string, publish: boolean) {
    let detail = await service.createProduct(productFixture.actor, {requestId: randomUUID(), brandId: productFixture.brandID, name,
      description: productFixture.description, category: productFixture.category, basePrice: data.price, currency,
      images: [productFixture.image], variants: [{sku: productFixture.skuPrefix + randomUUID(), stockQuantity: productFixture.stock}]});
    if (publish) {
      detail = await service.submitProduct(productFixture.actor, detail.product.id, {expectedVersion: detail.product.version});
      detail = await service.reviewProduct(detail.product.id, {expectedVersion: detail.product.version, decision: PRODUCT_STATUS.active, reviewerId: productFixture.adminID});
    }
    return detail.product.id;
  }
  const first = await create(data.first, productFixture.currency, true), second = await create(data.second, data.euro, true);
  const draft = await create(data.draft, productFixture.currency, false);
  return {repository, service, first, second, draft};
}
describe('Outfit product selection', () => {
  it('paginates canonical public product projections without exposing private fields', async () => {
    const {service, first, second, draft} = await setup();
    const page = await service.selectProducts({limit: data.pageSize});
    expect(page.items).toHaveLength(data.pageSize); expect(page.nextCursor).toBe(page.items[PRODUCT_EDITING.limits.firstIndex].id);
    const next = await service.selectProducts({limit: data.pageSize, cursor: page.nextCursor});
    const items = [...page.items, ...next.items];
    expect(new Set(items.map(item => item.id))).toEqual(new Set([first, second])); expect(next.nextCursor).toBeNull();
    expect(items.map(item => item.id)).not.toContain(draft);
    for (const item of items) {
      expect(item.brandName).toBe(productFixture.brandName); expect(item.price.min).toBe(data.price);
      expect(item).not.toHaveProperty('reviewedBy'); expect(item.variants[PRODUCT_EDITING.limits.firstIndex]).not.toHaveProperty('sku');
    }
  });
  it('uses literal name search and the actual brand state and filter', async () => {
    const {service, repository, first} = await setup();
    expect((await service.selectProducts({search: data.search})).items.map(item => item.id)).toEqual([first]);
    expect((await service.selectProducts({search: data.percent})).items.map(item => item.id)).toEqual([first]);
    expect((await service.selectProducts({search: data.underscore})).items).toHaveLength(data.none);
    expect((await service.selectProducts({brandId: randomUUID()})).items).toHaveLength(data.none);
    expect((await service.selectProducts({brandId: productFixture.brandID})).items).toHaveLength(data.total);
    repository.brands.get(productFixture.brandID)!.status = PROFILE_STATUS.paused;
    expect((await service.selectProducts({})).items).toHaveLength(data.none);
    expect(await repository.findActiveByIds([first])).toHaveLength(data.none);
  });
  it('rejects arbitrary state filters and malformed page input', async () => {
    const {service} = await setup();
    for (const query of [{status: PRODUCT_STATUS.draft}, {cursor: data.invalidCursor}, {search: data.blank}, {limit: data.none}]) {
      await expect(service.selectProducts(query)).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});
