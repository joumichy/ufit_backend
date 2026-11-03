import {BadRequestException, ForbiddenException, NotFoundException} from '@nestjs/common';
import {describe, expect, it, vi} from 'vitest';
import {AdminOrdersService} from '../../src/modules/orders/application/admin-orders.service';
import {adminOrderQuerySchema, type AdminOrderRepository} from '../../src/modules/orders/domain/admin-orders.contract';
import type {IdentityAccess} from '../../src/modules/identity/domain/user.types';

const actorId = 'c037dbdc-6b99-4555-8fe8-6a2a8b30aca2';
const orderId = 'b574fece-9cb1-409e-8a10-1488a47e1ad1';
const revision = 'b47be4ab696accc7603c3b731ef85235';
function setup(access?: IdentityAccess) {
  const repository: AdminOrderRepository = {
    snapshot: async operation => operation(repository), access: vi.fn(async () => access),
    page: vi.fn(async () => ({items: [], nextCursor: null, revision, totalCount: 0, currencies: [], asOf: '2026-11-03T14:00:00.000Z'})),
    detail: vi.fn(async () => undefined), relatedReturns: vi.fn(async () => ({items: [], nextCursor: null})),
  };
  return {repository, service: new AdminOrdersService(repository)};
}
describe('order administration query contract', () => {
  it('supports every order lifecycle including pending payment, currencies and shipping incidents', () => {
    expect(adminOrderQuerySchema.parse({search: ' UF-2026 ', status: 'pending_payment', currency: 'CHF', shipmentStatus: 'failed'}))
      .toEqual({search: 'UF-2026', status: 'pending_payment', currency: 'CHF', shipmentStatus: 'failed', limit: 20});
  });
  it('requires cursor and revision together to prevent mixing collection revisions', () => {
    expect(adminOrderQuerySchema.parse({cursor: orderId, revision}).cursor).toBe(orderId);
    for (const query of [{cursor: orderId}, {revision}, {revision: 'invalid', cursor: orderId}, {cursor: 'not-an-id', revision}]) {
      expect(adminOrderQuerySchema.safeParse(query).success).toBe(false);
    }
  });
  it('rejects unknown statuses, query aliases and unbounded pages', () => {
    for (const query of [{status: 'confirmed'}, {shipmentStatus: 'unknown'}, {currency: 'UNKNOWN'}, {limit: 51}, {limit: 0}, {search: 'x'.repeat(121)}, {customerId: actorId}, {offset: 20}]) {
      expect(adminOrderQuerySchema.safeParse(query).success).toBe(false);
    }
  });
});
describe('order administration authority', () => {
  it.each([undefined, {status: 'active', roles: ['customer']}, {status: 'active', roles: ['creator']},
    {status: 'active', roles: ['brand_owner']}, {status: 'suspended', roles: ['admin']} ] as Array<IdentityAccess | undefined>)('refuses actual access %j for list, detail and related returns', async access => {
    const {service, repository} = setup(access);
    await expect(service.list(actorId, {})).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.detail(actorId, orderId)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.relatedReturns(actorId, orderId, {})).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.page).not.toHaveBeenCalled(); expect(repository.detail).not.toHaveBeenCalled(); expect(repository.relatedReturns).not.toHaveBeenCalled();
  });
  it.each(['admin', 'super_admin'] as const)('permits an active %s and passes parsed filters only', async role => {
    const {service, repository} = setup({status: 'active', roles: [role]});
    await service.list(actorId, {search: ' Atelier ', shipmentStatus: 'failed'});
    expect(repository.page).toHaveBeenCalledWith({search: 'Atelier', shipmentStatus: 'failed', limit: 20});
  });
  it('rejects invalid identifiers and prevents related lookup for a missing order', async () => {
    const {service, repository} = setup({status: 'active', roles: ['admin']});
    expect(() => service.detail(actorId, 'unknown')).toThrow(BadRequestException);
    await expect(service.detail(actorId, orderId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.relatedReturns(actorId, orderId, {})).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.relatedReturns).not.toHaveBeenCalled();
  });
});
