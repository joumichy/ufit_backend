import {BadRequestException, ConflictException} from '@nestjs/common';
import {sql} from 'drizzle-orm';
import type {DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {DISBURSEMENT_EXECUTION as E} from '../../payments/domain/payment-disbursement.repository';
import {WORKSPACE_FINANCE as F, workspaceInteger, requireWorkspaceProjection, type WorkspaceFinanceScope} from '../domain/workspace-finance';
import {WORKSPACE_TRANSFERS as C, workspaceTransferPageSchema, type WorkspaceTransferPage, type WorkspaceTransferQuery} from '../domain/workspace-transfers';
import {workspaceTransferFacts} from './workspace-transfer-facts.sql';

export class DrizzleWorkspaceTransfersReader {
  constructor(private readonly database: DatabaseSession) {}
  async read(scope: WorkspaceFinanceScope, query: WorkspaceTransferQuery): Promise<WorkspaceTransferPage> {
    const facts = workspaceTransferFacts(scope), asOf = new Date().toISOString();
    const metadata = await this.database.db.execute(sql`${facts} select count(*)::text as total,
      count(*) filter(where invalid)::text as invalid,
      md5(coalesce(jsonb_agg(to_jsonb(t) order by recorded_at desc,id desc),${C.revision.empty}::jsonb)::text) as revision
      from transfer_records t`);
    const meta = metadata.rows[C.limits.zero];
    if (workspaceInteger(meta.invalid) !== C.limits.zero) throw new ConflictException(C.failure.persisted);
    if (query.revision !== undefined && query.revision !== meta.revision) throw new ConflictException(C.failure.changed);
    let after = sql`true`;
    if (query.cursor) {
      const anchor = await this.database.db.execute(sql`${facts} select id from transfer_records where id=${query.cursor}`);
      if (!anchor.rows.length) throw new BadRequestException(C.failure.cursor);
      after = sql`(recorded_at,id)<(select recorded_at,id from transfer_records where id=${query.cursor})`;
    }
    const totals = await this.database.db.execute(sql`${facts} select currency,live_mode as "liveMode",
      coalesce(sum(amount) filter(where kind=${E.operation.transfer}),${F.zero})::text as transferred,
      coalesce(sum(amount) filter(where kind=${E.operation.reversal}),${F.zero})::text as recovered,
      count(*) filter(where kind=${E.operation.transfer})::text as "transferCount",
      count(*) filter(where kind=${E.operation.reversal})::text as "reversalCount"
      from transfer_records group by currency,live_mode order by live_mode desc,currency`);
    const result = await this.database.db.execute(sql`${facts} select id,kind,amount,currency,live_mode as "liveMode",
      created_at as "createdAt",to_char(recorded_at at time zone ${F.timestamp.zone},${F.timestamp.format}) as "recordedAt",
      order_number as "orderNumber",brand_name as "brandName",item_name as "itemName",receipt_id as "receiptId",
      original_transfer_id as "originalTransferId" from transfer_records where ${after}
      order by recorded_at desc,id desc limit ${query.limit + C.limits.one}`);
    const items = result.rows.slice(C.limits.zero, query.limit);
    const currencies = totals.rows.map(row => {
      const transferred = workspaceInteger(row.transferred), recovered = workspaceInteger(row.recovered);
      return {currency: row.currency, liveMode: row.liveMode, transferred, recovered, netTransferred: transferred - recovered,
        transferCount: workspaceInteger(row.transferCount), reversalCount: workspaceInteger(row.reversalCount)};
    });
    return requireWorkspaceProjection(workspaceTransferPageSchema, {
      profileId: scope.profileId, kind: scope.kind, asOf, limit: query.limit, totalCount: workspaceInteger(meta.total),
      nextCursor: result.rows.length > query.limit ? items.at(-C.limits.one)!.id : null,
      revision: meta.revision, currencies, items,
    });
  }
}
