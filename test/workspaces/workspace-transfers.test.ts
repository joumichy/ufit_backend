import {describe, expect, it} from 'vitest';
import {workspaceTransferQuerySchema, workspaceTransferPageSchema} from '../../src/modules/workspaces/domain/workspace-transfers';

const F = {
  profile: '11111111-1111-4111-8111-111111111111', transfer: '22222222-2222-4222-8222-222222222222',
  reversal: '33333333-3333-4333-8333-333333333333', other: '44444444-4444-4444-8444-444444444444',
  revision: 'd751713988987e9331980363e24189ce', date: '2026-11-03T21:00:00.000Z',
  transferred: 100, recovered: 25, net: 75, currency: 'USD', receipt: 'tr_HistoryOriginal', reversalReceipt: 'trr_HistoryReturn',
  order: 'HISTORY-CONTRACT', brand: 'Contract brand', item: 'Frozen shirt',
} as const;
const transfer = {id: F.transfer, kind: 'transfer', amount: F.transferred, currency: F.currency, liveMode: false,
  createdAt: F.date, recordedAt: F.date, orderNumber: F.order, brandName: F.brand, itemName: null, receiptId: F.receipt, originalTransferId: null};
const reversal = {...transfer, id: F.reversal, kind: 'reversal', amount: F.recovered, receiptId: F.reversalReceipt, originalTransferId: F.receipt};
const currency = {currency: F.currency, liveMode: false, transferred: F.transferred, recovered: F.recovered,
  netTransferred: F.net, transferCount: 1, reversalCount: 1};
const document = {profileId: F.profile, kind: 'brand', asOf: F.date, limit: 20, totalCount: 2,
  nextCursor: null, revision: F.revision, currencies: [currency], items: [reversal, transfer]};

describe('beneficiary transfer history contract', () => {
  it('has an explicit empty history without inventing currencies or balances', () => {
    expect(workspaceTransferPageSchema.parse({...document, totalCount: 0, currencies: [], items: []}).currencies).toEqual([]);
  });
  it('retains registered transfers and recoveries with exact net amounts', () => {
    expect(workspaceTransferPageSchema.parse(document).currencies[0].netTransferred).toBe(F.net);
    expect(workspaceTransferPageSchema.safeParse({...document, currencies: [{...currency, netTransferred: F.transferred}]}).success).toBe(false);
  });
  it('separates live and test records even in the same currency', () => {
    const live = {...transfer, id: F.other, liveMode: true, receiptId: 'tr_HistoryLive'};
    const liveCurrency = {...currency, liveMode: true, recovered: 0, netTransferred: F.transferred, reversalCount: 0};
    expect(workspaceTransferPageSchema.safeParse({...document, totalCount: 3, currencies: [currency, liveCurrency], items: [live, ...document.items]}).success).toBe(true);
    expect(workspaceTransferPageSchema.safeParse({...document, totalCount: 4, currencies: [currency, currency]}).success).toBe(false);
  });
  it('rejects unbound receipts, unknown kinds and a recovery larger than the transferred amount', () => {
    for (const row of [{...reversal, originalTransferId: null}, {...transfer, receiptId: F.reversalReceipt}, {...transfer, kind: 'payout'}, {...transfer, receiptId: 'tr_?'}]) {
      expect(workspaceTransferPageSchema.safeParse({...document, items: [row]}).success).toBe(false);
    }
    expect(workspaceTransferPageSchema.safeParse({...document, currencies: [{...currency, recovered: F.transferred + F.recovered, netTransferred: -F.recovered}]}).success).toBe(false);
  });
  it('requires a frozen item label for creators and excludes creator item data from the brand projection', () => {
    expect(workspaceTransferPageSchema.safeParse({...document, kind: 'creator'}).success).toBe(false);
    const items = document.items.map(row => ({...row, itemName: F.item}));
    expect(workspaceTransferPageSchema.safeParse({...document, kind: 'creator', items}).success).toBe(true);
    expect(workspaceTransferPageSchema.safeParse({...document, items}).success).toBe(false);
  });
  it('rejects duplicate operations, inconsistent counts, unknown fields and a cursor not matching the last row', () => {
    for (const raw of [{...document, items: [transfer, transfer]}, {...document, totalCount: 3}, {...document, bankBalance: 100},
      {...document, nextCursor: F.other}, {...document, items: [{...transfer, currency: 'CHF'}]}]) {
      expect(workspaceTransferPageSchema.safeParse(raw).success).toBe(false);
    }
  });
  it('requires a paired cursor and revision and bounded integer pages', () => {
    expect(workspaceTransferQuerySchema.parse({})).toEqual({limit: 20});
    expect(workspaceTransferQuerySchema.parse({limit: '1', cursor: F.transfer, revision: F.revision}).limit).toBe(1);
    for (const query of [{cursor: F.transfer}, {revision: F.revision}, {limit: 0}, {limit: 51}, {limit: 1.5}, {amount: 100}, {profileId: F.other}]) {
      expect(workspaceTransferQuerySchema.safeParse(query).success).toBe(false);
    }
  });
});
