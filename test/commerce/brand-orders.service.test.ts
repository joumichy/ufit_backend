import {describe, expect, it, vi} from 'vitest';
import {BrandOrdersService} from '../../src/modules/orders/application/brand-orders.service';
import type {BrandManagementAccess} from '../../src/modules/brands/brands.repository';
import type {BrandOrderRepository} from '../../src/modules/orders/domain/brand-order.repository';
import {BrandOrderPageQuery} from '../../src/modules/orders/presentation/brand-orders.controller';
import {plainToInstance} from 'class-transformer';
import {validate} from 'class-validator';
const fixture = {actor: {id: 'owner'}, brand: 'brand', order: 'order', query: {limit: 20}};
function setup() {
  let access: BrandManagementAccess | undefined = {brand: {id: fixture.brand, brandName: 'Maison', status: 'active'}, actor: {status: 'active', roles: ['brand_owner']}, memberRole: 'owner'};
  const repository = {
    snapshot: async <T>(operation: (reader: BrandOrderRepository) => Promise<T>) => operation(repository as never),
    findManagementAccess: vi.fn(async () => access),
    list: vi.fn(async () => ({items: [], nextCursor: null})),
    detail: vi.fn(async () => undefined as unknown),
  };
  return {service: new BrandOrdersService(repository as never), repository, setAccess: (value: typeof access) => {access = value;}, access: access!};
}
describe('BrandOrdersService', () => {
  it('passes the exact stored scope to the paginated reader', async () => {
    const {service, repository} = setup();
    expect(await service.list(fixture.actor, fixture.brand, fixture.query)).toEqual({items: [], nextCursor: null});
    expect(repository.findManagementAccess).toHaveBeenCalledWith(fixture.brand, fixture.actor.id);
    expect(repository.list).toHaveBeenCalledWith(fixture.brand, fixture.query);
  });
  it('refuses a removed membership before reading private order data', async () => {
    const {service, repository, setAccess} = setup();setAccess(undefined);
    await expect(service.list(fixture.actor, fixture.brand, fixture.query)).rejects.toMatchObject({status: 403});
    await expect(service.detail(fixture.actor, fixture.brand, fixture.order)).rejects.toMatchObject({status: 403});
    expect(repository.list).not.toHaveBeenCalled();expect(repository.detail).not.toHaveBeenCalled();
  });
  it('does not trust administrator roles supplied by the caller', async () => {
    const {service, repository, access, setAccess} = setup();setAccess({...access, memberRole: null});
    await expect(service.list({...fixture.actor, roles: ['admin']} as never, fixture.brand, fixture.query)).rejects.toMatchObject({status: 403});
    expect(repository.list).not.toHaveBeenCalled();
  });
  it('permits a persisted administrator and a paused brand, while refusing suspended actors or brands', async () => {
    const {service, access, setAccess} = setup();
    setAccess({...access, brand: {...access.brand, status: 'paused'}, memberRole: null, actor: {...access.actor, roles: ['admin']}});
    await expect(service.list(fixture.actor, fixture.brand, fixture.query)).resolves.toEqual({items: [], nextCursor: null});
    for(const invalid of [{...access, brand: {...access.brand, status: 'suspended' as const}}, {...access, actor: {...access.actor, status: 'suspended' as const}}]) {
      setAccess(invalid);await expect(service.list(fixture.actor, fixture.brand, fixture.query)).rejects.toMatchObject({status: 403});
    }
  });
  it('does not expose an order from a different brand', async () => {
    const {service, repository} = setup();
    await expect(service.detail(fixture.actor, fixture.brand, fixture.order)).rejects.toMatchObject({status: 404, response: {code: 'brand_order_not_found'}});
    expect(repository.detail).toHaveBeenCalledWith(fixture.brand, fixture.order);
  });
  it('validates page bounds, cursor identifiers and the fulfillment status vocabulary', async () => {
    for(const input of [{limit: 0}, {limit: 51}, {cursor: 'foreign-format'}, {status: 'pending_payment'}, {status: 'unknown'}, {limit: 'x'}]) {
      expect((await validate(plainToInstance(BrandOrderPageQuery, input))).length).toBeGreaterThan(0);
    }
    expect(await validate(plainToInstance(BrandOrderPageQuery, {limit: '50', status: 'preparing'}))).toEqual([]);
  });
});
