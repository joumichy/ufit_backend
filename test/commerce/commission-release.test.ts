import {commissionEntrySchema} from '../../src/modules/commissions/domain/commission-entry.contract';
import {describe, expect, it} from 'vitest';
import {commissionReleaseSchema} from '../../src/modules/commissions/domain/commission-release';

const row = {
  id: 'aab605b4-f111-4abb-8fa9-bdbeeb308aa1', orderItemId: '771d6390-c24d-4686-8af8-ceb354e12b39',
  brandId: '5af33e92-3d45-47cf-930a-4489c5ca3450', sourceOutfitId: 'b9596f35-969d-459b-aefc-a8656f191c1c',
  creator: {id: '11111111-1111-4111-8111-111111111111', name: 'Créateur de qualification'}, sale: {orderNumber: 'QUAL-COMMISSION', productName: 'Chemise figée', brandName: 'Marque de qualification', quantity: 3}, currency: 'BHD', baseAmount: 300, rateBps: 833, originalAmount: 25, adjustedAmount: 8, netAmount: 17,
  paidAdjustmentAmount: 0, createdAt: '2026-11-01T00:00:00.000Z',
};
const date = '2026-11-03T12:00:00.000Z';
describe('commission release wire contract', () => {
  it.each([
    ['awaiting_delivery', null, 'pending'], ['return_window', date, 'pending'], ['return_open', date, 'pending'],
    ['cancellation_open', null, 'pending'], ['payable', date, 'validated'], ['estimated', null, 'estimated'],
  ])('requires status consistent with %s without changing the frozen principal', (state, availableAt, status) => {
    const document = {...row, status, release: {state, availableAt}};
    expect(commissionEntrySchema.parse(document)).toEqual(document);
    expect(commissionEntrySchema.safeParse({...document, status: 'paid'}).success).toBe(false);
  });
  it.each([
    {state: 'payable', availableAt: null}, {state: 'return_window', availableAt: null},
    {state: 'return_window'}, {state: 'payable', availableAt: date, dueAt: date},
    {state: 'paid', availableAt: date}, {state: 'awaiting_delivery', availableAt: date},
    {state: 'cancelled', availableAt: date}, {state: 'estimated', availableAt: date},
    {state: 'available', availableAt: date}, {state: 'return_window', availableAt: '03/11/2026'},
  ])('rejects missing, inferred or conflicting maturity fields %j', input => {
    expect(commissionReleaseSchema.safeParse(input).success).toBe(false);
  });
});
