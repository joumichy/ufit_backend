import {describe, expect, it} from 'vitest';
import {revenuePeriod, revenueWindow, workspaceRevenueSchema, WORKSPACE_REVENUE} from '../../src/modules/workspaces/domain/workspace-revenue';

describe('workspace revenue cohorts', () => {
  it('uses UTC dates across month, year and leap-day boundaries', () => {
    const value = revenueWindow('30d', new Date('2024-03-01T00:30:00.000Z'));
    expect(value.start).toBe('2024-02-01'); expect(value.end).toBe('2024-03-02');
    expect(value.dates).toHaveLength(30); expect(value.dates.at(-2)).toBe('2024-02-29');
    const year = revenueWindow('12m', new Date('2026-01-31T23:59:59.000Z'));
    expect(year.start).toBe('2025-02-01'); expect(year.dates).toHaveLength(12); expect(year.dates.at(-1)).toBe('2026-01-01');
  });
  it('keeps Monday buckets while clipping the first week to the requested 90 days', () => {
    const value = revenueWindow('90d', new Date('2026-11-03T12:00:00.000Z'));
    expect(value.start).toBe('2026-08-06'); expect(value.dates[0]).toBe('2026-08-03');
    expect(value.dates.at(-1)).toBe('2026-11-02'); expect(value.granularity).toBe('week');
  });
  it('rejects unsupported periods and extra query keys instead of silently changing the period', () => {
    expect(revenuePeriod({})).toBe(WORKSPACE_REVENUE.defaultPeriod);
    for (const value of [{period:'all'}, {period:'30d',currency:'CHF'}, {period:['30d','90d']}]) expect(() => revenuePeriod(value)).toThrow();
  });
  const window = revenueWindow('12m', new Date('2026-11-03T12:00:00.000Z'));
  const zero = {orders:0,captured:0,refunded:0,refundPending:0,salesNet:0,original:0,adjusted:0,commissionNet:0,estimated:0,pending:0,available:0,paid:0,paidAdjustment:0};
  const points = window.dates.map(date => ({date,...zero}));
  const document = {profileId:'11111111-1111-4111-8111-111111111111',kind:'creator',basis:'attributed_merchandise',period:window.period,
    granularity:window.granularity,start:window.start,end:window.end,asOf:window.asOf,currencies:[{currency:'CHF',liveMode:false,points}]};
  it('retains explicit empty periods and independent currencies', () => {
    expect(workspaceRevenueSchema.parse({...document,currencies:[]}).currencies).toEqual([]);
    expect(workspaceRevenueSchema.parse({...document,currencies:['CHF','JPY','BHD'].map(currency=>({currency,liveMode:false,points}))}).currencies).toHaveLength(3);
  });
  it('requires an explicit mode and groups all three mode states independently', () => {
    const currencies = [true, false, null].map(liveMode => ({...document.currencies[0], liveMode}));
    expect(workspaceRevenueSchema.parse({...document, currencies}).currencies).toEqual(currencies);
    const {liveMode: omitted, ...missing} = document.currencies[0];
    for (const row of [missing, {...missing, liveMode: 'test'}, {...missing, liveMode: 1}]) {
      expect(workspaceRevenueSchema.safeParse({...document, currencies: [row]}).success).toBe(false);
    }
    expect(workspaceRevenueSchema.safeParse({...document, currencies: [currencies[2], currencies[2]]}).success).toBe(false);
  });
  it('rejects missing/duplicated/out-of-order buckets, invented net amounts and duplicate currencies', () => {
    for (const rows of [points.slice(1),[...points,points[0]],[...points].reverse(),points.map((row,i)=>i===0?{...row,captured:100,salesNet:99}:row)]) {
      expect(workspaceRevenueSchema.safeParse({...document,currencies:[{currency:'CHF',liveMode:false,points:rows}]}).success).toBe(false);
    }
    expect(workspaceRevenueSchema.safeParse({...document,currencies:[document.currencies[0],document.currencies[0]]}).success).toBe(false);
  });
  it('separates available from paid and keeps paid adjustments visible', () => {
    const row = {...points[0],original:100,adjusted:30,commissionNet:70,pending:20,available:0,paid:80,paidAdjustment:30};
    expect(workspaceRevenueSchema.safeParse({...document,currencies:[{currency:'CHF',liveMode:false,points:[row,...points.slice(1)]}]}).success).toBe(true);
    expect(workspaceRevenueSchema.safeParse({...document,currencies:[{currency:'CHF',liveMode:false,points:[{...row,available:80},...points.slice(1)]}]}).success).toBe(false);
  });
});
