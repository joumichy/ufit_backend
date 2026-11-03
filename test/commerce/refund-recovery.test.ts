import 'reflect-metadata';
import {describe, expect, it, vi} from 'vitest';
import {GUARDS_METADATA, PATH_METADATA} from '@nestjs/common/constants';
import {RefundRecoveryService} from '../../src/modules/orders/application/refund-recovery.service';
import {RefundRecoveryController} from '../../src/modules/orders/presentation/refund-recovery.controller';
import {REFUND_RECOVERY, refundRecoveryCursor, type RefundRecoveryDetail, type RefundRecoverySummary} from '../../src/modules/orders/domain/refund-recovery.contract';
import {AuthGuard} from '../../src/shared/presentation/guards/auth.guard';
import {RoleGuard} from '../../src/shared/presentation/guards/role.guard';
import {ROLES_METADATA_KEY} from '../../src/shared/presentation/decorators/roles.decorator';
import {CANCELLATION_REFUND} from '../../src/modules/orders/domain/order-lifecycle';

const fixture = {
  id: 'be8933b5-b716-43c0-baf7-f9df561b79bf', orderId: '752eddb3-6789-48ec-b093-6d1c281aee74',
  brandId: '6af02f80-3ff8-4daa-b875-36e8c4044934', attemptId: '17628926-ae67-4320-b8a4-e5049a14f623',
  brandName: 'Maison de qualification', orderNumber: 'QUAL-RECOVERY', amount: 500, currency: 'CHF',
  failedAt: '2026-11-03T00:00:00.000Z', firstAttempt: 1, minimumLimit: '1', maximumLimit: '50',
  query: '  QUAL-RECOVERY  ', invalidKind: 'order', invalidId: 'foreign-id',
  invalidCursor: 'foreign-cursor', legacyTime: 'failedAt', unknownField: 'unexpected',
  metadataList: 'list', metadataDetail: 'detail', status: {badRequest: 400, notFound: 404},
} as const;
const summary: RefundRecoverySummary = {kind: REFUND_RECOVERY.kind.orderReturn, id: fixture.id, orderId: fixture.orderId,
  brandId: fixture.brandId, brandName: fixture.brandName, orderNumber: fixture.orderNumber, amount: fixture.amount,
  currency: fixture.currency, failedAt: fixture.failedAt, cause: REFUND_RECOVERY.cause.blocked};
const document: RefundRecoveryDetail = {summary, attempt: {id: fixture.attemptId, number: fixture.firstAttempt,
  state: CANCELLATION_REFUND.state.blocked, providerStatus: null, refundId: null}};
function setup() {
  const page = {items: [summary], totalCount: fixture.firstAttempt, nextCursor: null};
  const repository = {list: vi.fn(async () => page), detail: vi.fn(async (): Promise<RefundRecoveryDetail | undefined> => document)};
  return {service: new RefundRecoveryService(repository), repository, page};
}
function cursor(raw: unknown) {return Buffer.from(JSON.stringify(raw)).toString(REFUND_RECOVERY.cursorEncoding);}
describe('Refund recovery administration contract', () => {
  it('passes one canonical query and returns the exact repository projection', async () => {
    const {service, repository, page} = setup();
    expect(await service.list({search: fixture.query, limit: fixture.maximumLimit})).toBe(page);
    expect(repository.list).toHaveBeenCalledExactlyOnceWith({limit: REFUND_RECOVERY.page.maximumLimit,
      search: fixture.orderNumber, kind: undefined, cursor: undefined});
    await service.list({});
    expect(repository.list).toHaveBeenLastCalledWith({limit: REFUND_RECOVERY.page.defaultLimit, kind: undefined, search: undefined, cursor: undefined});
  });
  it('round-trips only origin kind and identity in the cursor, without a truncated display timestamp', async () => {
    const {service, repository} = setup(), encoded = refundRecoveryCursor(summary);
    expect(JSON.parse(Buffer.from(encoded, REFUND_RECOVERY.cursorEncoding).toString())).toEqual({kind: summary.kind, id: summary.id});
    await service.list({limit: fixture.minimumLimit, kind: summary.kind, cursor: encoded});
    expect(repository.list).toHaveBeenCalledExactlyOnceWith({limit: REFUND_RECOVERY.page.minimumLimit, kind: summary.kind,
      search: undefined, cursor: {kind: summary.kind, id: summary.id}});
  });
  it.each([{limit: 0}, {limit: 51}, {limit: 1.5}, {limit: 'x'}, {search: ''}, {search: '   '},
    {search: 'x'.repeat(REFUND_RECOVERY.search.maximumLength + REFUND_RECOVERY.page.overflow)},
    {search: [fixture.orderNumber]}, {kind: fixture.invalidKind}, {[fixture.unknownField]: true}])('rejects malformed list query %j before reading', raw => {
    const {service, repository} = setup();
    expect(() => service.list(raw)).toThrow(expect.objectContaining({status: fixture.status.badRequest}));
    expect(repository.list).not.toHaveBeenCalled();
  });
  it.each([fixture.invalidCursor, cursor({kind: summary.kind, id: fixture.invalidId}),
    cursor({kind: fixture.invalidKind, id: summary.id}), cursor({id: summary.id}),
    cursor({kind: summary.kind, id: summary.id, [fixture.legacyTime]: fixture.failedAt}),
    refundRecoveryCursor(summary) + '='])('rejects noncanonical cursor %s before reading', encoded => {
    const {service, repository} = setup();
    expect(() => service.list({cursor: encoded})).toThrow(expect.objectContaining({status: fixture.status.badRequest}));
    expect(repository.list).not.toHaveBeenCalled();
  });
  it('rejects a cursor from a different origin filter', () => {
    const {service, repository} = setup();
    expect(() => service.list({kind: REFUND_RECOVERY.kind.cancellation, cursor: refundRecoveryCursor(summary)})).toThrow();
    expect(repository.list).not.toHaveBeenCalled();
  });
  it('returns the nested detail unchanged and does not substitute the order identity for the origin identity', async () => {
    const {service, repository} = setup();
    expect(await service.detail(summary.kind, summary.id)).toBe(document);
    expect(repository.detail).toHaveBeenCalledExactlyOnceWith(summary.kind, summary.id);
    repository.detail.mockResolvedValueOnce(undefined);
    await expect(service.detail(summary.kind, fixture.orderId)).rejects.toMatchObject({status: fixture.status.notFound});
  });
  it.each([[fixture.invalidKind, fixture.id], [summary.kind, fixture.invalidId]])('rejects invalid detail %s/%s before reading', async (kind, id) => {
    const {service, repository} = setup();
    await expect(service.detail(kind, id)).rejects.toMatchObject({status: fixture.status.badRequest});
    expect(repository.detail).not.toHaveBeenCalled();
  });
  it('protects both endpoints through authentication and persisted administrator roles', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, RefundRecoveryController)).toEqual([AuthGuard, RoleGuard]);
    expect(Reflect.getMetadata(ROLES_METADATA_KEY, RefundRecoveryController)).toEqual(REFUND_RECOVERY.roles);
    expect(Reflect.getMetadata(PATH_METADATA, RefundRecoveryController)).toBe(REFUND_RECOVERY.route.root);
    expect(Reflect.getMetadata(PATH_METADATA, RefundRecoveryController.prototype[fixture.metadataDetail])).toBe(REFUND_RECOVERY.route.detail);
  });
});
