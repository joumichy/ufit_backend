import {ConflictException} from '@nestjs/common';
import {sql} from 'drizzle-orm';
import type {DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {commissionFinancialFacts} from '../../commissions/infrastructure/commission-financial-facts.sql';
import {COMMISSION_RELEASE} from '../../commissions/domain/commission-release';
import {ORDER_COMMISSION} from '../../orders/domain/order-lifecycle';
import {WORKSPACE_FINANCE as FINANCE, workspaceFinancialGroup, workspaceFinancialModeSchema, requireWorkspaceProjection, workspaceInteger, type WorkspaceFinanceScope} from '../domain/workspace-finance';
import {WORKSPACE_REVENUE as C, revenueWindow, workspaceRevenueSchema, type RevenuePeriod, type WorkspaceRevenue} from '../domain/workspace-revenue';
import {workspaceSalesFacts} from './workspace-sales-facts.sql';

/** Uses the same facts and repeatable-read snapshot as the all-time dashboard. */
export class DrizzleWorkspaceRevenueReader {
  constructor(private readonly database: DatabaseSession) {}
  async read(scope: WorkspaceFinanceScope, period: RevenuePeriod): Promise<WorkspaceRevenue> {
    const clock = await this.database.db.execute(sql`select current_timestamp as "asOf"`);
    const window = revenueWindow(period, new Date(clock.rows[0].asOf as string));
    const {granularity, start, asOf} = window;
    const sales = await this.database.db.execute(sql`
      ${workspaceSalesFacts(scope)}
      select currency, live_mode as "liveMode", to_char(date_trunc(${granularity},created_at at time zone ${FINANCE.timestamp.zone}), ${C.bucketDateFormat}) as date,
        count(*)::text as orders, sum(captured)::text as captured, sum(refunded)::text as refunded, sum(pending)::text as "refundPending",
        (sum(captured)-sum(refunded))::text as "salesNet",
        count(*) filter(where invalid or captured<${FINANCE.zero} or refunded<${FINANCE.zero} or pending<${FINANCE.zero} or refunded+pending>captured)::text as "invalidCount"
      from facts where created_at>=${start}::date at time zone ${FINANCE.timestamp.zone} and created_at<=${asOf}::timestamptz
      group by currency,live_mode,date order by live_mode desc nulls last,currency,date
    `);
    const commissions = scope.kind === FINANCE.scope.creator ? await this.database.db.execute(sql`
      ${commissionFinancialFacts({kind: COMMISSION_RELEASE.scope.creator, creatorId: scope.profileId})}
      select currency,live_mode as "liveMode",to_char(date_trunc(${granularity},created_at at time zone ${FINANCE.timestamp.zone}), ${C.bucketDateFormat}) as date,
        sum(original)::text as original,sum(adjusted)::text as adjusted,sum(original-adjusted)::text as "commissionNet",
        coalesce(sum(original-adjusted) filter(where status=${ORDER_COMMISSION.status.estimated}),${FINANCE.zero})::text as estimated,
        coalesce(sum(original-adjusted) filter(where status=${ORDER_COMMISSION.status.pending}),${FINANCE.zero})::text as pending,
        coalesce(sum(original-adjusted) filter(where status=${ORDER_COMMISSION.status.validated}),${FINANCE.zero})::text as available,
        coalesce(sum(original) filter(where status=${ORDER_COMMISSION.status.paid}),${FINANCE.zero})::text as paid,
        coalesce(sum(returned) filter(where status=${ORDER_COMMISSION.status.paid}),${FINANCE.zero})::text as "paidAdjustment",
        count(*) filter(where invalid)::text as "invalidCount"
      from facts where created_at>=${start}::date at time zone ${FINANCE.timestamp.zone} and created_at<=${asOf}::timestamptz
      group by currency,live_mode,date order by live_mode desc nulls last,currency,date
    `) : {rows: []};
    const currencies = new Map<string, WorkspaceRevenue['currencies'][number]>();
    for (const [rows, fields] of [[sales.rows, C.salesFields], [commissions.rows, C.commissionFields]] as const) {
      for (const row of rows) {
        if (workspaceInteger(row.invalidCount) !== FINANCE.zero || typeof row.currency !== 'string' || !workspaceFinancialModeSchema.safeParse(row.liveMode).success) throw new ConflictException(FINANCE.failure.persisted);
        const liveMode = workspaceFinancialModeSchema.parse(row.liveMode), key = workspaceFinancialGroup(row.currency, liveMode);
        let currency = currencies.get(key);
        if (!currency) {
          currency = {currency: row.currency, liveMode, points: window.dates.map(date => ({date, orders: 0, captured: 0, refunded: 0, refundPending: 0, salesNet: 0,
            original: 0, adjusted: 0, commissionNet: 0, estimated: 0, pending: 0, available: 0, paid: 0, paidAdjustment: 0}))};
          currencies.set(key, currency);
        }
        const point = currency.points.find(value => value.date === row.date);
        if (!point) throw new ConflictException(FINANCE.failure.persisted);
        for (const field of fields) point[field] = workspaceInteger(row[field]);
      }
    }
    return requireWorkspaceProjection(workspaceRevenueSchema, {profileId: scope.profileId, kind: scope.kind,
      basis: scope.kind === FINANCE.scope.creator ? FINANCE.basis.attributedMerchandise : FINANCE.basis.orderTotal,
      period, granularity, start, end: window.end, asOf, currencies: [...currencies.values()].sort((a,b) => (a.liveMode === b.liveMode ? a.currency.localeCompare(b.currency) : a.liveMode === true ? -C.step : b.liveMode === true ? C.step : a.liveMode === false ? -C.step : C.step))});
  }
}
