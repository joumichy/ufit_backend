import { ConflictException, Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import {commissionFinancialFacts} from '../../commissions/infrastructure/commission-financial-facts.sql';
import {COMMISSION_RELEASE} from '../../commissions/domain/commission-release';
import {ORDER_COMMISSION} from '../../orders/domain/order-lifecycle';
import {WORKSPACE_FINANCE,workspaceInteger} from '../../workspaces/domain/workspace-finance';
import {availableApplicant} from '../../applications/application-visibility';
import {ADMIN_ACTIVITY, ADMIN_QUEUE, type AdminActivity} from '../domain/admin-activity.contract';
import {READ_SNAPSHOT,type DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import { DatabaseService } from '../../../shared/infrastructure/database/database.service';
import {
  brandApplications,
  creatorApplications,
  orders
} from '../../../shared/infrastructure/database/schema';
import type { AdminPage, AdminQueueItem, AdminQueueName, AdminRepository } from '../application/admin.service';

const applicationStatuses = ['submitted', 'under_review', 'waitlisted', 'needs_more_info'] as const;
const orderStatuses = ['paid', 'preparing'] as const;
const commissionStatuses = [ORDER_COMMISSION.status.pending, ORDER_COMMISSION.status.estimated] as const;
const commissionQueueType = 'commission';
const commissionTimestamp = {zone:'UTC',format:'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'};
const commissionQueueCondition = sql`status in (${sql.join(commissionStatuses.map(value=>sql`${value}`),sql`, `)})`;
const administrationCommissionFacts = commissionFinancialFacts({kind:COMMISSION_RELEASE.scope.administration});

@Injectable()
export class DrizzleAdminRepository implements AdminRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseSession) {}

  async countReviewQueues(): Promise<AdminActivity> {
    return this.database.db.transaction(async tx => {
      const [creators] = await tx.select({value: count()}).from(creatorApplications)
        .where(and(inArray(creatorApplications.status, ADMIN_ACTIVITY.applicationStatuses),availableApplicant(creatorApplications.userId)));
      const [brands] = await tx.select({value: count()}).from(brandApplications)
        .where(and(inArray(brandApplications.status, ADMIN_ACTIVITY.applicationStatuses),availableApplicant(brandApplications.userId)));
      if (!creators || !brands) throw new InternalServerErrorException(ADMIN_ACTIVITY.invalid);
      const result = {applications: creators.value + brands.value};
      if (Object.values(result).some(value => !Number.isSafeInteger(value) || value < ADMIN_ACTIVITY.minimumCount)) {
        throw new InternalServerErrorException(ADMIN_ACTIVITY.invalid);
      }
      return result;
    }, READ_SNAPSHOT);
  }

  async countQueues(): Promise<Record<AdminQueueName, number>> {
    const [creatorApplicationCount, brandApplicationCount, orderCount, commissionCount] = await Promise.all([
      this.countCreatorApplications(),
      this.countBrandApplications(),
      this.countOrders(),
      this.countCommissions()
    ]);

    return {
      applications: creatorApplicationCount + brandApplicationCount,
      orders: orderCount,
      commissions: commissionCount
    };
  }

  async listQueue(queue: AdminQueueName, page: { limit: number; offset: number }): Promise<AdminPage<AdminQueueItem>> {
    switch (queue) {
      case ADMIN_QUEUE.kind.applications:
        return this.listApplications(page);
      case ADMIN_QUEUE.kind.orders:
        return this.listOrders(page);
      case ADMIN_QUEUE.kind.commissions:
        return this.listCommissions(page);
    }
  }

  private async listApplications(page: { limit: number; offset: number }): Promise<AdminPage<AdminQueueItem>> {
    const [creatorRows, brandRows, total] = await Promise.all([
      this.database.db
        .select()
        .from(creatorApplications)
        .where(and(inArray(creatorApplications.status, applicationStatuses),availableApplicant(creatorApplications.userId)))
        .orderBy(desc(creatorApplications.submittedAt))
        .limit(page.limit + page.offset),
      this.database.db
        .select()
        .from(brandApplications)
        .where(and(inArray(brandApplications.status, applicationStatuses),availableApplicant(brandApplications.userId)))
        .orderBy(desc(brandApplications.submittedAt))
        .limit(page.limit + page.offset),
      this.countCreatorApplications().then(async (creatorTotal) => creatorTotal + (await this.countBrandApplications()))
    ]);

    const items = [
      ...creatorRows.map((row): AdminQueueItem => ({
        id: row.id,
        type: 'creator_application',
        status: row.status,
        ownerId: row.userId,
        title: row.displayName,
        submittedAt: row.submittedAt.toISOString()
      })),
      ...brandRows.map((row): AdminQueueItem => ({
        id: row.id,
        type: 'brand_application',
        status: row.status,
        ownerId: row.userId,
        title: row.brandName,
        submittedAt: row.submittedAt.toISOString()
      }))
    ]
      .sort((left, right) => (right.submittedAt ?? '').localeCompare(left.submittedAt ?? ''))
      .slice(page.offset, page.offset + page.limit);

    return this.toPage(items, page, total);
  }

  private async listOrders(page: { limit: number; offset: number }): Promise<AdminPage<AdminQueueItem>> {
    const [rows, total] = await Promise.all([
      this.database.db
        .select()
        .from(orders)
        .where(inArray(orders.status, orderStatuses))
        .orderBy(desc(orders.createdAt))
        .limit(page.limit)
        .offset(page.offset),
      this.countOrders()
    ]);

    return this.toPage(
      rows.map((row) => ({
        id: row.id,
        type: 'order',
        status: row.status,
        ownerId: row.customerId,
        title: row.orderNumber,
        amount: row.totalAmount,
        currency: row.currency,
        submittedAt: row.createdAt?.toISOString() ?? null
      })),
      page,
      total
    );
  }

  private async listCommissions(page: { limit: number; offset: number }): Promise<AdminPage<AdminQueueItem>> {
    return this.database.db.transaction(async tx=>{
      const reader=new DrizzleAdminRepository({db:tx}),total=await reader.countCommissions();
      const result=await tx.execute(sql`${administrationCommissionFacts}
        select id,status,creator_id as "ownerId",order_number as title,(original-adjusted)::text as amount,currency,
          to_char(created_at at time zone ${commissionTimestamp.zone},${commissionTimestamp.format}) as "submittedAt"
        from facts where ${commissionQueueCondition} order by created_at desc,id desc limit ${page.limit} offset ${page.offset}`);
      return this.toPage(result.rows.map(row=>({id:row.id as string,type:commissionQueueType,status:row.status as string,
        ownerId:row.ownerId as string,title:row.title as string,amount:workspaceInteger(row.amount),currency:row.currency as string,submittedAt:row.submittedAt as string})),page,total);
    },READ_SNAPSHOT);
  }

  private async countCreatorApplications(): Promise<number> {
    const [row] = await this.database.db
      .select({ value: count() })
      .from(creatorApplications)
      .where(and(inArray(creatorApplications.status, applicationStatuses),availableApplicant(creatorApplications.userId)));
    return row?.value ?? 0;
  }

  private async countBrandApplications(): Promise<number> {
    const [row] = await this.database.db
      .select({ value: count() })
      .from(brandApplications)
      .where(and(inArray(brandApplications.status, applicationStatuses),availableApplicant(brandApplications.userId)));
    return row?.value ?? 0;
  }

  private async countOrders(): Promise<number> {
    const [row] = await this.database.db.select({ value: count() }).from(orders).where(inArray(orders.status, orderStatuses));
    return row?.value ?? 0;
  }

  private async countCommissions(): Promise<number> {
    const result=await this.database.db.execute(sql`${administrationCommissionFacts} select count(*) filter(where ${commissionQueueCondition})::text as total,
      count(*) filter(where invalid)::text as invalid from facts`);
    const row=result.rows[WORKSPACE_FINANCE.zero];
    if(workspaceInteger(row.invalid)!==WORKSPACE_FINANCE.zero)throw new ConflictException(WORKSPACE_FINANCE.failure.persisted);
    return workspaceInteger(row.total);
  }

  private toPage<T>(items: T[], page: { limit: number; offset: number }, total: number): AdminPage<T> {
    const nextOffset = page.offset + items.length < total ? page.offset + items.length : null;
    return {
      items,
      page: {
        limit: page.limit,
        offset: page.offset,
        total,
        nextOffset
      }
    };
  }
}
