import {BadRequestException} from '@nestjs/common';
import {z} from 'zod';
import {CURRENCY_CODES} from '../../../shared/domain/currencies';
import {WORKSPACE_FINANCE} from './workspace-finance';

const periods = {month: '30d', quarter: '90d', year: '12m'} as const;
const granularity = {day: 'day', week: 'week', month: 'month'} as const;
export const WORKSPACE_REVENUE = {
  period: periods,
  granularity,
  bucketDateFormat: 'YYYY-MM-DD',
  step: 1,
  periods: [periods.month, periods.quarter, periods.year],
  defaultPeriod: periods.month,
  dayMilliseconds: 86_400_000,
  dayCount: {short: 30, long: 90},
  monthCount: 12,
  weekDays: 7,
  monday: 1,
  dateLength: 10,
  invalidQuery: 'Invalid revenue period',
  salesFields: ['orders', 'captured', 'refunded', 'refundPending', 'salesNet'],
  commissionFields: ['original', 'adjusted', 'commissionNet', 'estimated', 'pending', 'available', 'paid', 'paidAdjustment'],
} as const;
export type RevenuePeriod = (typeof WORKSPACE_REVENUE.periods)[number];
export type RevenueWindow = {period: RevenuePeriod; granularity: (typeof granularity)[keyof typeof granularity]; start: string; end: string; asOf: string; dates: string[]};
const query = z.object({period: z.enum(WORKSPACE_REVENUE.periods).default(WORKSPACE_REVENUE.defaultPeriod)}).strict();
export function revenuePeriod(raw: unknown): RevenuePeriod {
  const result = query.safeParse(raw);
  if (!result.success) throw new BadRequestException(WORKSPACE_REVENUE.invalidQuery);
  return result.data.period;
}
const dateString = (date: Date) => date.toISOString().slice(0, WORKSPACE_REVENUE.dateLength);
/** UTC cohorts: inclusive first day, exclusive next day; the current bucket is partial. */
export function revenueWindow(period: RevenuePeriod, now: Date): RevenueWindow {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start.getTime() + WORKSPACE_REVENUE.dayMilliseconds);
  const granularity = period === WORKSPACE_REVENUE.period.year ? WORKSPACE_REVENUE.granularity.month : period === WORKSPACE_REVENUE.period.quarter ? WORKSPACE_REVENUE.granularity.week : WORKSPACE_REVENUE.granularity.day;
  if (period === WORKSPACE_REVENUE.period.year) start.setUTCMonth(start.getUTCMonth() - WORKSPACE_REVENUE.monthCount + WORKSPACE_REVENUE.step, WORKSPACE_REVENUE.step);
  else start.setUTCDate(start.getUTCDate() - (period === WORKSPACE_REVENUE.period.quarter ? WORKSPACE_REVENUE.dayCount.long : WORKSPACE_REVENUE.dayCount.short) + WORKSPACE_REVENUE.step);
  const tick = new Date(start);
  if (granularity === WORKSPACE_REVENUE.granularity.week) tick.setUTCDate(tick.getUTCDate() - (tick.getUTCDay() + WORKSPACE_REVENUE.weekDays - WORKSPACE_REVENUE.monday) % WORKSPACE_REVENUE.weekDays);
  const dates: string[] = [];
  while (tick < end) {
    dates.push(dateString(tick));
    if (granularity === WORKSPACE_REVENUE.granularity.month) tick.setUTCMonth(tick.getUTCMonth() + WORKSPACE_REVENUE.step);
    else tick.setUTCDate(tick.getUTCDate() + (granularity === WORKSPACE_REVENUE.granularity.week ? WORKSPACE_REVENUE.weekDays : WORKSPACE_REVENUE.step));
  }
  return {period, granularity, start: dateString(start), end: dateString(end), asOf: now.toISOString(), dates};
}
const amount = z.number().int().min(0).max(WORKSPACE_FINANCE.maximum);
const date = z.iso.date();
const point = z.object({date, orders: amount, captured: amount, refunded: amount, refundPending: amount, salesNet: amount,
  original: amount, adjusted: amount, commissionNet: amount, estimated: amount, pending: amount, available: amount, paid: amount, paidAdjustment: amount,
}).strict().refine(row => BigInt(row.refunded) + BigInt(row.salesNet) === BigInt(row.captured)
  && BigInt(row.refunded) + BigInt(row.refundPending) <= BigInt(row.captured)
  && BigInt(row.original) - BigInt(row.adjusted) === BigInt(row.commissionNet)
  && BigInt(row.estimated) + BigInt(row.pending) + BigInt(row.available) + BigInt(row.paid) - BigInt(row.paidAdjustment) === BigInt(row.commissionNet)
  && row.paidAdjustment <= row.paid);
export const workspaceRevenueSchema = z.object({
  profileId: z.uuid(), kind: z.enum([WORKSPACE_FINANCE.scope.creator, WORKSPACE_FINANCE.scope.brand]),
  basis: z.enum([WORKSPACE_FINANCE.basis.orderTotal, WORKSPACE_FINANCE.basis.attributedMerchandise]),
  period: z.enum(WORKSPACE_REVENUE.periods), granularity: z.enum([granularity.day, granularity.week, granularity.month]),
  start: date, end: date, asOf: z.iso.datetime(),
  currencies: z.array(z.object({currency: z.string().refine(value => CURRENCY_CODES.includes(value)), points: z.array(point)}).strict()),
}).strict().superRefine((value, context) => {
  const expected = revenueWindow(value.period, new Date(value.asOf));
  if (value.start !== expected.start || value.end !== expected.end || value.granularity !== expected.granularity
    || new Set(value.currencies.map(row => row.currency)).size !== value.currencies.length
    || value.basis !== (value.kind === WORKSPACE_FINANCE.scope.creator ? WORKSPACE_FINANCE.basis.attributedMerchandise : WORKSPACE_FINANCE.basis.orderTotal)) context.addIssue({code: 'custom', message: 'Invalid revenue window'});
  for (const currency of value.currencies) {
    if (currency.points.length !== expected.dates.length || currency.points.some((row, i) => row.date !== expected.dates[i])) context.addIssue({code: 'custom', message: 'Invalid revenue buckets'});
    for (const field of [...WORKSPACE_REVENUE.salesFields, ...WORKSPACE_REVENUE.commissionFields]) {
      if (currency.points.reduce((sum, row) => sum + BigInt(row[field]), 0n) > BigInt(WORKSPACE_FINANCE.maximum)) context.addIssue({code: 'custom', message: 'Revenue sum exceeds exact integer range'});
    }
    if (value.kind === WORKSPACE_FINANCE.scope.brand && currency.points.some(row => WORKSPACE_REVENUE.commissionFields.some(field => row[field] !== 0))) context.addIssue({code: 'custom', message: 'Brand revenue cannot contain creator commission states'});
  }
});
export type WorkspaceRevenue = z.infer<typeof workspaceRevenueSchema>;
