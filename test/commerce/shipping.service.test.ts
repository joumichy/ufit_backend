import {describe, expect, it} from 'vitest';
import {ShippingService} from '../../src/modules/shipping/application/shipping.service';
import {shipmentActionSchema, shipmentActions, SHIPMENT_STATUS} from '../../src/modules/shipping/domain/shipping.contract';
import {InMemoryShipmentRepository} from '../../src/modules/shipping/infrastructure/in-memory-shipping.repository';
import {ORDER_STATUS} from '../../src/modules/orders/domain/order-lifecycle';
import type {BrandManagementAccess} from '../../src/modules/brands/brands.repository';
const fixture = {
  order: 'order', brand: 'brand', actor: {id: 'brand-user'}, carrier: 'Poste de qualification', tracking: 'QUALIFICATION', url: 'https://example.test/tracking',
  incident: 'Le colis est bloqué chez le transporteur.',
};
function setup() {
  const repository = new InMemoryShipmentRepository(), service = new ShippingService(repository);
  const access: BrandManagementAccess = {brand: {id: fixture.brand, brandName: 'Maison', status: 'active'}, actor: {status: 'active', roles: ['brand_owner']}, memberRole: 'owner'};
  repository.access.set(fixture.actor.id, new Map([[fixture.brand, access]]));
  repository.orderStatuses.set(fixture.order, ORDER_STATUS.paid);
  return {repository, service, access};
}
async function prepared() {
  const state = setup();
  const shipment = await state.service.createPendingForPaidOrder(fixture.order, fixture.brand);
  const result = await state.service.updateForActor(fixture.actor, shipment.id, {action: 'prepare', expectedVersion: 1});
  return {...state, result};
}
describe('ShippingService', () => {
  it('prepares only a persisted paid order and advances both states and revision', async () => {
    const {result, repository} = await prepared();
    expect(result).toMatchObject({orderStatus: 'preparing', shipment: {version: 2, status: 'preparing'}, actions: ['ship', 'report_incident']});
    expect(repository.orderStatuses.get(fixture.order)).toBe('preparing');
  });
  it('requires the canonical action and version; rejects forged scope and raw legacy status', () => {
    for (const input of [{nextStatus: 'preparing'}, {action: 'prepare'}, {action: 'prepare', expectedVersion: 0}, {action: 'prepare', expectedVersion: 1, brandId: 'other'}, {action: 'ship', expectedVersion: 1, carrier: fixture.carrier}]) {
      expect(shipmentActionSchema.safeParse(input).success).toBe(false);
    }
  });
  it('requires carrier and tracking, rejects insecure links, preserves exact canonical nulls', async () => {
    const {service, result} = await prepared();
    await expect(service.updateForActor(fixture.actor, result.shipment.id, {action: 'ship', expectedVersion: 2, carrier: fixture.carrier, trackingNumber: fixture.tracking, trackingUrl: 'http://example.test/track'})).rejects.toMatchObject({status: 400});
    const shipped = await service.updateForActor(fixture.actor, result.shipment.id, {action: 'ship', expectedVersion: 2, carrier: fixture.carrier, trackingNumber: fixture.tracking});
    expect(shipped).toMatchObject({orderStatus: 'shipped', shipment: {status: 'shipped', version: 3, carrier: fixture.carrier, trackingNumber: fixture.tracking, trackingUrl: null, deliveredAt: null, incidentReason: null, incidentAt: null}});
    expect(Number.isNaN(Date.parse(shipped.shipment.shippedAt!))).toBe(false);
  });
  it('rejects a stale retry without a second transition', async () => {
    const {service, repository, result} = await prepared();
    await expect(service.updateForActor(fixture.actor, result.shipment.id, {action: 'prepare', expectedVersion: 1})).rejects.toMatchObject({status: 409, response: {code: 'shipment_version_changed'}});
    expect(await repository.findById(result.shipment.id)).toEqual(result.shipment);
  });
  it('uses current persisted access rather than caller roles or membership', async () => {
    const {service, repository, result} = await prepared();
    repository.access.get(fixture.actor.id)!.delete(fixture.brand);
    await expect(service.updateForActor({...fixture.actor, roles: ['admin']} as never, result.shipment.id, {action: 'report_incident', expectedVersion: 2, incidentReason: fixture.incident})).rejects.toMatchObject({status: 403});
    expect((await repository.findById(result.shipment.id))?.version).toBe(2);
  });
  it('refuses suspended accounts and revoked roles but allows paused brands', async () => {
    const {service, result, access, repository} = await prepared();
    for (const invalid of [{...access, actor: {...access.actor, status: 'suspended' as const}}, {...access, actor: {...access.actor, roles: ['customer'] as BrandManagementAccess['actor']['roles']}}]) {
      repository.access.get(fixture.actor.id)!.set(fixture.brand, invalid);
      await expect(service.updateForActor(fixture.actor, result.shipment.id, {action: 'report_incident', expectedVersion: 2, incidentReason: fixture.incident})).rejects.toMatchObject({status: 403});
    }
    repository.access.get(fixture.actor.id)!.set(fixture.brand, {...access, brand: {...access.brand, status: 'paused'}});
    expect((await service.updateForActor(fixture.actor, result.shipment.id, {action: 'report_incident', expectedVersion: 2, incidentReason: fixture.incident})).shipment.status).toBe('failed');
  });
  it('reports and resolves an incident while preserving tracking and the order stage', async () => {
    const {service, result} = await prepared();
    const shipped = await service.updateForActor(fixture.actor, result.shipment.id, {action: 'ship', expectedVersion: 2, carrier: fixture.carrier, trackingNumber: fixture.tracking, trackingUrl: fixture.url});
    const incident = await service.updateForActor(fixture.actor, result.shipment.id, {action: 'report_incident', expectedVersion: 3, incidentReason: fixture.incident});
    expect(incident).toMatchObject({orderStatus: 'shipped', actions: ['resolve_incident'], shipment: {status: 'failed', version: 4, incidentReason: fixture.incident, shippedAt: shipped.shipment.shippedAt}});
    await expect(service.updateForActor(fixture.actor, result.shipment.id, {action: 'deliver', expectedVersion: 4})).rejects.toMatchObject({status: 409});
    const resumed = await service.updateForActor(fixture.actor, result.shipment.id, {action: 'resolve_incident', expectedVersion: 4});
    expect(resumed).toMatchObject({orderStatus: 'shipped', shipment: {version: 5, status: 'shipped', trackingUrl: fixture.url, shippedAt: shipped.shipment.shippedAt, incidentReason: fixture.incident, incidentAt: incident.shipment.incidentAt}});
  });
  it('resolves incidents before preparation and before shipping without advancing the order', async () => {
    for (const startPreparing of [false, true]) {
      const {service} = setup(); const shipment = await service.createPendingForPaidOrder(fixture.order, fixture.brand);
      if (startPreparing) await service.updateForActor(fixture.actor, shipment.id, {action: 'prepare', expectedVersion: 1});
      const version = startPreparing ? 2 : 1;
      await service.updateForActor(fixture.actor, shipment.id, {action: 'report_incident', expectedVersion: version, incidentReason: fixture.incident});
      const result = await service.updateForActor(fixture.actor, shipment.id, {action: 'resolve_incident', expectedVersion: version + 1});
      expect(result.shipment.status).toBe(startPreparing ? 'preparing' : 'pending'); expect(result.orderStatus).toBe(startPreparing ? 'preparing' : 'paid');
    }
  });
  it('corrects tracking without resetting shipment date and permits removing an optional URL', async () => {
    const {service, result} = await prepared();
    const shipped = await service.updateForActor(fixture.actor, result.shipment.id, {action: 'ship', expectedVersion: 2, carrier: fixture.carrier, trackingNumber: fixture.tracking, trackingUrl: fixture.url});
    const corrected = await service.updateForActor(fixture.actor, result.shipment.id, {action: 'update_tracking', expectedVersion: 3, carrier: fixture.carrier, trackingNumber: 'CORRECTED', trackingUrl: null});
    expect(corrected.shipment).toMatchObject({version: 4, trackingNumber: 'CORRECTED', trackingUrl: null, shippedAt: shipped.shipment.shippedAt});
  });
  it('delivers once, then refuses incidents and any rollback', async () => {
    const {service, result} = await prepared();
    await service.updateForActor(fixture.actor, result.shipment.id, {action: 'ship', expectedVersion: 2, carrier: fixture.carrier, trackingNumber: fixture.tracking});
    const delivered = await service.updateForActor(fixture.actor, result.shipment.id, {action: 'deliver', expectedVersion: 3});
    expect(delivered).toMatchObject({orderStatus: 'delivered', actions: [], shipment: {version: 4, status: 'delivered'}});
    expect(delivered.shipment.deliveredAt).not.toBeNull();
    await expect(service.updateForActor(fixture.actor, result.shipment.id, {action: 'report_incident', expectedVersion: 4, incidentReason: fixture.incident})).rejects.toMatchObject({status: 409});
  });
  it('exposes no actions for cancelled orders or incoherent persisted order/shipment pairs', () => {
    const {service} = setup(), shipment = service.createManualShipment(fixture.order, fixture.brand);
    expect(shipmentActions({shipment, orderStatus: ORDER_STATUS.cancelled})).toEqual([]);
    expect(shipmentActions({shipment: {...shipment, status: SHIPMENT_STATUS.preparing}, orderStatus: ORDER_STATUS.paid})).toEqual([]);
  });
  it('reuses the existing shipment for a paid order', async () => {
    const {service} = setup(); const first = await service.createPendingForPaidOrder(fixture.order, fixture.brand);
    expect(await service.createPendingForPaidOrder(fixture.order, fixture.brand)).toEqual(first);
  });
});
