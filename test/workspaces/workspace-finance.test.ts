import {commissionEntrySchema} from '../../src/modules/commissions/domain/commission-entry.contract';
import {ConflictException} from '@nestjs/common';
import {describe, expect, it} from 'vitest';
import {workspaceInteger, workspaceSalesSchema, workspaceCommissionCurrencySchema} from '../../src/modules/workspaces/domain/workspace-finance';

const sales = {currency: 'CHF', liveMode: false, capturedOrderCount: 1, capturedAmount: 26780, refundedAmount: 12990, refundInProgressAmount: 13790, netAmount: 13790};
const commissions = {currency: 'CHF', liveMode: false, originalAmount: 100, adjustedAmount: 30, netAmount: 70,
  estimatedAmount: 0, pendingAmount: 20, validatedAmount: 0, paidAmount: 80, paidAdjustmentAmount: 30,
  estimatedCount: 0, pendingCount: 1, validatedCount: 0, paidCount: 1, cancelledCount: 0};

describe('workspace financial contracts', () => {
  it('keeps zero, two and three decimal currencies separate without adding an empty default currency', () => {
    expect(workspaceSalesSchema.parse({basis: 'order_total', currencies: []}).currencies).toEqual([]);
    const currencies = ['CHF', 'JPY', 'BHD'].map(currency => ({...sales, currency}));
    expect(workspaceSalesSchema.parse({basis: 'order_total', currencies}).currencies).toEqual(currencies);
  });
  it.each(['0', '2147483648', '9007199254740991'])('reads exact aggregate integer text %s', value => {
    expect(BigInt(workspaceInteger(value))).toBe(BigInt(value));
  });
  it.each([null, undefined, 0, '01', '-1', '1.0', '1e3', '9007199254740992'])('rejects ambiguous or unsafe SQL values: %j', value => {
    expect(() => workspaceInteger(value)).toThrow(ConflictException);
  });
  it.each([
    {...sales, netAmount: 0}, {...sales, refundInProgressAmount: 13791}, {...sales, currency: 'INVALID'},
    {...sales, capturedAmount: Number.MAX_SAFE_INTEGER + 1}, {...sales, capturedOrderCount: 0},
  ])('rejects incoherent sales %j', value => {
    expect(workspaceSalesSchema.safeParse({basis: 'order_total', currencies: [value]}).success).toBe(false);
  });
  it('rejects duplicate currency/mode groups and the previous grossAmount contract', () => {
    expect(workspaceSalesSchema.safeParse({basis: 'order_total', currencies: [sales, sales]}).success).toBe(false);
    expect(workspaceSalesSchema.safeParse({paidOrderCount: 1, grossAmount: 26780, currency: 'CHF'}).success).toBe(false);
    expect(workspaceSalesSchema.safeParse({basis: 'order_total', currencies: [sales], currency: 'CHF'}).success).toBe(false);
  });
  it('keeps test, live and unclassified captures separate in the same currency', () => {
    const currencies = [true, false, null].map(liveMode => ({...sales, liveMode}));
    expect(workspaceSalesSchema.parse({basis: 'order_total', currencies}).currencies).toEqual(currencies);
    const {liveMode: removed, ...missing} = sales;
    for (const row of [missing, {...sales, liveMode: 'false'}, {...sales, liveMode: 0}]) {
      expect(workspaceSalesSchema.safeParse({basis: 'order_total', currencies: [row]}).success).toBe(false);
    }
    for (const liveMode of [true, false, null]) {
      expect(workspaceCommissionCurrencySchema.parse({...commissions, liveMode}).liveMode).toBe(liveMode);
    }
    const {liveMode: omitted, ...unclassifiedWithoutField} = commissions;
    expect(workspaceCommissionCurrencySchema.safeParse(unclassifiedWithoutField).success).toBe(false);
  });
  it('requires one exact commission row with frozen currency, integer basis points and an explicit timestamp', () => {
    const row = {id: 'aab605b4-f111-4abb-8fa9-bdbeeb308aa1', orderItemId: '771d6390-c24d-4686-8af8-ceb354e12b39',
      brandId: '5af33e92-3d45-47cf-930a-4489c5ca3450', sourceOutfitId: 'b9596f35-969d-459b-aefc-a8656f191c1c',
      status: 'paid', creator: {id: '11111111-1111-4111-8111-111111111111', name: 'Créateur de qualification'}, sale: {orderNumber: 'QUAL-COMMISSION', productName: 'Chemise figée', brandName: 'Marque de qualification', quantity: 3}, currency: 'BHD', baseAmount: 300, rateBps: 833, originalAmount: 25, adjustedAmount: 16, netAmount: 9,
      paidAdjustmentAmount: 16, release: {state: 'paid', availableAt: null}, createdAt: '2026-11-01T00:00:00.000Z'};
    expect(commissionEntrySchema.parse(row)).toEqual(row);
    for (const invalid of [{...row, commissionAmount: 25}, {...row, rateBps: 0.0833}, {...row, createdAt: null},
      {...row, paidAdjustmentAmount: 15}, {...row, status: 'pending', paidAdjustmentAmount: 16}, {...row, netAmount: 25},
      {...row, release: undefined}, {...row, release: {state: 'payable', availableAt: '2026-11-01T00:00:00.000Z'}}]) {
      expect(commissionEntrySchema.safeParse(invalid).success).toBe(false);
    }
    const {currency: removedCurrency, ...missingCurrency} = row;
    expect(commissionEntrySchema.safeParse(missingCurrency).success).toBe(false);
  });
  it('retains paid principal and identifies its return adjustment without claiming a provider reversal', () => {
    expect(workspaceCommissionCurrencySchema.parse(commissions)).toEqual(commissions);
    expect(workspaceCommissionCurrencySchema.safeParse({...commissions, paidAdjustmentAmount: 31}).success).toBe(false);
    expect(workspaceCommissionCurrencySchema.safeParse({...commissions, adjustedAmount: 101, netAmount: 0}).success).toBe(false);
    expect(workspaceCommissionCurrencySchema.safeParse({...commissions, pendingAmount: 19}).success).toBe(false);
  });
});
