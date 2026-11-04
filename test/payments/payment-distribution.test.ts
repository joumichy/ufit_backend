import {describe, expect, it} from 'vitest';
import {ConflictException} from '@nestjs/common';
import {PaymentDistributionService} from '../../src/modules/payments/application/payment-distribution.service';
import {PAYMENT_DISTRIBUTION as C, distributionChangeSchema, distributionDocumentSchema, distributionRevisionSchema,
  platformCommissionAmount, DistributionBudgetExceeded, type DistributionBrandQuery, type DistributionChange,
  type DistributionDocument, type DistributionPageQuery, type DistributionRevision} from '../../src/modules/payments/domain/payment-distribution';
import type {DistributionChangeReceipt, PaymentDistributionRepository} from '../../src/modules/payments/domain/payment-distribution.repository';
import type {IdentityAccess} from '../../src/modules/identity/domain/user.types';

const F = {
  actor: '11111111-1111-4111-8111-111111111111', brand: '22222222-2222-4222-8222-222222222222',
  other: '33333333-3333-4333-8333-333333333333', request: '44444444-4444-4444-8444-444444444444',
  nextRequest: '55555555-5555-4555-8555-555555555555', policy: '66666666-6666-4666-8666-666666666666',
  nextPolicy: '77777777-7777-4777-8777-777777777777',
  brandDocument: {id: '22222222-2222-4222-8222-222222222222', name: 'Distribution contract brand', status: 'active'} as const,
  firstAt: '2026-11-03T12:00:00.000Z', nextAt: '2026-11-03T12:01:00.000Z',
  reason: 'Explicit inactive qualification conditions', rate: 175,
  base: 10_000, creator: 1_200, platform: 175, halfBase: 5, halfRate: 1_000, roundedHalf: 1,
  overflowCreator: 9_999,
};
function input(): DistributionChange {return {requestId: F.request, expectedRevision: 0, platformRateBps: F.rate, feeBearer: 'brand', active: false, reason: F.reason};}
class Repository implements PaymentDistributionRepository {
  identity: IdentityAccess = {status: 'active', roles: ['admin']};
  current: DistributionRevision | null = null;
  readonly changes = new Map<string, DistributionChangeReceipt>();
  writes = 0;
  transaction<T>(_write: boolean, operation: (repository: PaymentDistributionRepository) => Promise<T>): Promise<T> {return operation(this);}
  async access(_actor: string) {return this.identity;}
  async brands(query: DistributionBrandQuery) {
    if (query.search || query.cursor) return {items: [], nextCursor: null};
    return {items: [{brand: F.brandDocument, current: structuredClone(this.current)}], nextCursor: null};
  }
  async document(brandId: string): Promise<DistributionDocument | undefined> {
    return brandId === F.brand ? {brand: F.brandDocument, current: structuredClone(this.current), asOf: F.nextAt} : undefined;
  }
  async history(brandId: string, _query: DistributionPageQuery) {
    return {brandId, items: [...this.changes.values()].map(row => structuredClone(row.revision)).sort((a,b) => b.revision-a.revision), nextCursor: null};
  }
  async change(requestId: string) {const receipt = this.changes.get(requestId);return receipt ? structuredClone(receipt) : undefined;}
  async revise(brandId: string, actorId: string, requestHash: string, change: DistributionChange, current: DistributionRevision | null) {
    distributionChangeSchema.parse(change);
    if (current) {
      const previous = this.changes.get(current.requestId)!;
      previous.revision = {...previous.revision, supersededAt: F.nextAt};
    }
    const revision = distributionRevisionSchema.parse({id: current ? F.nextPolicy : F.policy, brandId, requestId: change.requestId,
      revision: change.expectedRevision + 1, previousId: current?.id ?? null, platformRateBps: change.platformRateBps,
      feeBearer: change.feeBearer, active: change.active, reason: change.reason, createdAt: current ? F.nextAt : F.firstAt, supersededAt: null});
    this.changes.set(change.requestId, {revision: structuredClone(revision), actorId, requestHash});
    this.current = structuredClone(revision);this.writes += 1;return revision;
  }
  async assertOrderTerms(_orderId: string): Promise<void> {throw new ConflictException(C.failure.order);}
}
function setup() {const repository = new Repository();return {repository, service: new PaymentDistributionService(repository)};}

describe('Payment distribution conditions', () => {
  it('checks sale terms before an order exists, without revising a policy or inventing a default', async () => {
    const {repository,service}=setup();
    await expect(service.assertSaleTerms(F.brand,F.base,F.creator)).rejects.toMatchObject({response:C.failure.unavailable});
    await service.revise(F.actor,F.brand,{...input(),active:true});
    const writes=repository.writes;
    await expect(service.assertSaleTerms(F.brand,F.base,F.creator)).resolves.toBeUndefined();
    expect(repository.writes).toBe(writes);
    await expect(service.assertSaleTerms(F.brand,F.base,F.overflowCreator)).rejects.toMatchObject({response:C.failure.budget});
    expect(repository.writes).toBe(writes);
  });
  it('does not accept an explicitly inactive sale configuration', async () => {
    const {service}=setup();await service.revise(F.actor,F.brand,input());
    await expect(service.assertSaleTerms(F.brand,F.base,F.creator)).rejects.toMatchObject({response:C.failure.unavailable});
  });
  it('requires each commercial choice explicitly, while allowing an explicitly entered zero rate and initial revision', () => {
    expect(distributionChangeSchema.parse({...input(), platformRateBps: 0}).platformRateBps).toBe(0);
    const absentRate = {...input(), platformRateBps: undefined};
    const absentBearer = {...input(), feeBearer: undefined};
    expect(distributionChangeSchema.safeParse(absentRate).success).toBe(false);
    expect(distributionChangeSchema.safeParse(absentBearer).success).toBe(false);
    expect(distributionChangeSchema.safeParse({...input(), feePayer: 'brand'}).success).toBe(false);
    expect(distributionChangeSchema.safeParse({...input(), platformRateBps: 1.5}).success).toBe(false);
    expect(distributionChangeSchema.safeParse({...input(), expectedRevision: 2147483647}).success).toBe(false);
    expect(distributionChangeSchema.safeParse({...input(), reason: '   '}).success).toBe(false);
  });
  it('calculates on merchandise exactly and rejects an overcommitted creator/platform budget without clipping', () => {
    expect(platformCommissionAmount(F.base,F.creator,F.rate)).toBe(F.platform);
    expect(platformCommissionAmount(F.halfBase,0,F.halfRate)).toBe(F.roundedHalf);
    expect(() => platformCommissionAmount(F.base,F.overflowCreator,F.rate)).toThrow(DistributionBudgetExceeded);
  });
  it('describes a real unconfigured brand with null conditions, never an invented default', async () => {
    const {service} = setup();const document = await service.document(F.actor,F.brand);
    expect(document.current).toBeNull();expect(distributionDocumentSchema.safeParse(document).success).toBe(true);
  });
  it('creates a revision and replays its exact request without a second write', async () => {
    const {service,repository} = setup();const first = await service.revise(F.actor,F.brand,input());
    const replay = await service.revise(F.actor,F.brand,input());
    expect(replay.receipt).toEqual(first.receipt);expect(repository.writes).toBe(1);
    expect(await service.change(F.actor,F.brand,F.request)).toEqual(replay);
  });
  it('returns the original receipt alongside the latest revision after another accepted edit', async () => {
    const {service,repository} = setup();const first = await service.revise(F.actor,F.brand,input());
    const second = await service.revise(F.actor,F.brand,{...input(),requestId:F.nextRequest,expectedRevision:1,feeBearer:'platform'});
    const old = await service.revise(F.actor,F.brand,input());
    expect(old.receipt.id).toBe(first.receipt.id);expect(old.receipt.supersededAt).toBe(F.nextAt);
    expect(old.document.current?.id).toBe(second.receipt.id);expect(repository.writes).toBe(2);
    expect((await service.history(F.actor,F.brand,{})).items.map(row => row.revision)).toEqual([2,1]);
  });
  it('rejects a stale revision and a reused request with changed values or actor', async () => {
    const {service,repository} = setup();await service.revise(F.actor,F.brand,input());
    await expect(service.revise(F.actor,F.brand,{...input(),requestId:F.nextRequest})).rejects.toMatchObject({response:C.failure.changed});
    await expect(service.revise(F.actor,F.brand,{...input(),platformRateBps:0})).rejects.toMatchObject({response:C.failure.reused});
    await expect(service.revise(F.other,F.brand,input())).rejects.toMatchObject({response:C.failure.reused});
    expect(repository.writes).toBe(1);
  });
  it.each(['customer','creator','brand_owner'] as const)('denies %s read and write before exposing conditions', async role => {
    const {service,repository} = setup();repository.identity = {status:'active',roles:[role]};
    await expect(service.document(F.actor,F.brand)).rejects.toMatchObject({response:C.failure.access});
    await expect(service.revise(F.actor,F.brand,input())).rejects.toMatchObject({response:C.failure.access});
    expect(repository.writes).toBe(0);
  });
  it('denies inactive administration and does not disclose another actor or brand change receipt', async () => {
    const {service,repository} = setup();await service.revise(F.actor,F.brand,input());
    await expect(service.change(F.other,F.brand,F.request)).rejects.toMatchObject({response:C.failure.receipt});
    await expect(service.document(F.actor,F.other)).rejects.toMatchObject({response:C.failure.missing});
    repository.identity = {status:'suspended',roles:['admin']};
    await expect(service.history(F.actor,F.brand,{})).rejects.toMatchObject({response:C.failure.access});
  });
  it('rejects malformed identifiers and unknown query fields instead of accepting alternate contracts', async () => {
    const {service} = setup();
    expect(() => service.document(F.actor,'brand')).toThrow(C.failure.input.message);
    expect(() => service.brands(F.actor,{offset:0})).toThrow(C.failure.input.message);
    expect(() => service.history(F.actor,F.brand,{limit:51})).toThrow(C.failure.input.message);
  });
});
