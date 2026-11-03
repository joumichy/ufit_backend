import {workspaceSalesFacts} from './workspace-sales-facts.sql';
import {ConflictException} from '@nestjs/common';
import {sql} from 'drizzle-orm';
import type {DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {ORDER_COMMISSION} from '../../orders/domain/order-lifecycle';
import {commissionFinancialFacts} from '../../commissions/infrastructure/commission-financial-facts.sql';
import {COMMISSION_RELEASE} from '../../commissions/domain/commission-release';
import {WORKSPACE_FINANCE as FINANCE, WORKSPACE_COMMISSION_FIELDS, requireWorkspaceProjection, workspaceInteger, workspaceSalesSchema, workspaceCommissionCurrencySchema,
  type WorkspaceFinanceScope, type WorkspaceSales, type WorkspaceCommissionCurrency} from '../domain/workspace-finance';

/** Aggregates each refund and each commission once before joining their owners. */
export class DrizzleWorkspaceFinanceReader {
  constructor(private readonly database: DatabaseSession) {}
  async sales(scope: WorkspaceFinanceScope): Promise<WorkspaceSales> {
    const creator = scope.kind === FINANCE.scope.creator;
    const result = await this.database.db.execute(sql`
      ${workspaceSalesFacts(scope)}
      select currency, live_mode as "liveMode", count(*)::text as "capturedOrderCount", sum(captured)::text as "capturedAmount", sum(refunded)::text as "refundedAmount",
        sum(pending)::text as "refundInProgressAmount", (sum(captured) - sum(refunded))::text as "netAmount",
        count(*) filter (where invalid or captured < ${FINANCE.zero} or refunded < ${FINANCE.zero} or pending < ${FINANCE.zero} or refunded + pending > captured)::text as "invalidCount"
      from facts group by currency,live_mode order by live_mode desc nulls last,currency
    `);
    const currencies = result.rows.map(row => {
      if (workspaceInteger(row.invalidCount) !== FINANCE.zero) throw new ConflictException(FINANCE.failure.persisted);
      return {currency: row.currency, liveMode: row.liveMode, capturedOrderCount: workspaceInteger(row.capturedOrderCount), capturedAmount: workspaceInteger(row.capturedAmount),
        refundedAmount: workspaceInteger(row.refundedAmount), refundInProgressAmount: workspaceInteger(row.refundInProgressAmount), netAmount: workspaceInteger(row.netAmount)};
    });
    return requireWorkspaceProjection(workspaceSalesSchema, {basis: creator ? FINANCE.basis.attributedMerchandise : FINANCE.basis.orderTotal, currencies});
  }
  async creatorCommissions(creatorId: string): Promise<WorkspaceCommissionCurrency[]> {
    const status = ORDER_COMMISSION.status;
    const result = await this.database.db.execute(sql`
      ${commissionFinancialFacts({kind: COMMISSION_RELEASE.scope.creator, creatorId})}
      select currency, live_mode as "liveMode", sum(original)::text as "originalAmount", sum(adjusted)::text as "adjustedAmount", sum(original - adjusted)::text as "netAmount",
        coalesce(sum(original - adjusted) filter (where status = ${status.estimated}), ${FINANCE.zero})::text as "estimatedAmount",
        coalesce(sum(original - adjusted) filter (where status = ${status.pending}), ${FINANCE.zero})::text as "pendingAmount",
        coalesce(sum(original - adjusted) filter (where status = ${status.validated}), ${FINANCE.zero})::text as "validatedAmount",
        coalesce(sum(original) filter (where status = ${status.paid}), ${FINANCE.zero})::text as "paidAmount",
        coalesce(sum(returned) filter (where status = ${status.paid}), ${FINANCE.zero})::text as "paidAdjustmentAmount",
        count(*) filter (where status = ${status.estimated})::text as "estimatedCount", count(*) filter (where status = ${status.pending})::text as "pendingCount",
        count(*) filter (where status = ${status.validated})::text as "validatedCount", count(*) filter (where status = ${status.paid})::text as "paidCount",
        count(*) filter (where status = ${status.cancelled})::text as "cancelledCount", count(*) filter (where invalid)::text as "invalidCount"
      from facts group by currency,live_mode order by live_mode desc nulls last,currency
    `);
    return result.rows.map(row => {
      if (workspaceInteger(row.invalidCount) !== FINANCE.zero) throw new ConflictException(FINANCE.failure.persisted);
      const amounts = Object.fromEntries(WORKSPACE_COMMISSION_FIELDS.map(key => [key, workspaceInteger(row[key])]));
      return requireWorkspaceProjection(workspaceCommissionCurrencySchema, {currency: row.currency, liveMode: row.liveMode, ...amounts});
    });
  }
}
