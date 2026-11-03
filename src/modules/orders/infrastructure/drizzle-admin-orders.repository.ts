import {BadRequestException, ConflictException, Inject, Injectable} from '@nestjs/common';
import {eq, sql, type SQL} from 'drizzle-orm';
import {z} from 'zod';
import {DatabaseService} from '../../../shared/infrastructure/database/database.service';
import {READ_SNAPSHOT, type DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {orders, orderItems, brandProfiles, payments, shipments, orderReturns} from '../../../shared/infrastructure/database/schema';
import {findIdentityAccess, IdentityAccessMode} from '../../identity/infrastructure/persistence/identity-access';
import {ADMIN_ORDERS as A, adminOrderPageSchema, adminOrderPaymentSchema, adminOrderSummarySchema,
  type AdminOrderRepository, type AdminOrderQuery, type AdminOrderDetail, type AdminOrderReturnsQuery} from '../domain/admin-orders.contract';
import {DrizzleOrderRepository} from './drizzle-orders.repository';
import {DrizzleOrderReturnRepository} from './drizzle-order-return.repository';
import {RETURN_ACTOR} from '../domain/order-return';

const l = A.limit;
const date = A.timestamp;
const asOf = sql`to_char(current_timestamp at time zone ${date.zone},${date.format})`;
const collection = sql`with all_orders as (
  select o.id,o.order_number,o.brand_id,b.brand_name,o.status,o.created_at,o.updated_at,o.total_amount,o.currency,
    (select coalesce(sum(i.quantity),${l.zero}) from ${orderItems} i where i.order_id=o.id) as item_count,
    s.status as shipment_status,s.updated_at as shipment_updated_at,
    exists(select ${l.one} from ${payments} p where p.order_id=o.id) as payment_recorded,
    (select coalesce(jsonb_agg(to_jsonb(p) order by p.id),${A.revision.empty}::jsonb) from ${payments} p where p.order_id=o.id) as payment_revision,
    (select count(*) from ${orderReturns} r where r.order_id=o.id) as return_count
  from ${orders} o join ${brandProfiles} b on b.id=o.brand_id left join ${shipments} s on s.order_id=o.id
)`;
@Injectable()
export class DrizzleAdminOrdersRepository implements AdminOrderRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseSession) {}
  snapshot<T>(operation: (repository: AdminOrderRepository) => Promise<T>): Promise<T> {
    return this.database.db.transaction(tx => operation(new DrizzleAdminOrdersRepository({db: tx})), READ_SNAPSHOT);
  }
  access(actorId: string) { return findIdentityAccess(this.database, actorId, IdentityAccessMode.Read); }
  async page(query: AdminOrderQuery) {
    const conditions: SQL[] = [];
    if (query.status) conditions.push(sql`status=${query.status}`);
    if (query.currency) conditions.push(sql`currency=${query.currency}`);
    if (query.shipmentStatus) conditions.push(sql`shipment_status=${query.shipmentStatus}`);
    if (query.search) {
      const pattern = A.search.wildcard + query.search.replace(A.search.escaped, value => A.search.escape + value) + A.search.wildcard;
      conditions.push(sql`(order_number ilike ${pattern} escape ${A.search.escape} or brand_name ilike ${pattern} escape ${A.search.escape})`);
    }
    const filter = conditions.length ? sql.join(conditions, sql` and `) : sql`true`;
    const scoped = sql`${collection}, selected_orders as (select * from all_orders where ${filter})`;
    const metadata = await this.database.db.execute(sql`${scoped} select count(*)::text as count,
      md5(coalesce(jsonb_agg(to_jsonb(o) order by created_at desc,id desc),${A.revision.empty}::jsonb)::text) as revision,
      ${asOf} as "asOf",array(select distinct currency from all_orders order by currency) as currencies from selected_orders o`);
    const meta = metadata.rows[l.zero];
    if (query.revision !== undefined && query.revision !== meta.revision) throw new ConflictException(A.failure.changed);
    let after = sql`true`;
    if (query.cursor) {
      const anchor = await this.database.db.execute(sql`${scoped} select id from selected_orders where id=${query.cursor}`);
      if (!anchor.rows[l.zero]) throw new BadRequestException(A.failure.cursor);
      after = sql`(created_at,id)<(select a.created_at,a.id from selected_orders a where a.id=${query.cursor})`;
    }
    const result = await this.database.db.execute(sql`${scoped} select id,order_number as "orderNumber",brand_id as "brandId",brand_name as "brandName",status,
      to_char(created_at at time zone ${date.zone},${date.format}) as "createdAt",total_amount as "totalAmount",currency,
      item_count::text as "itemCount",shipment_status as "shipmentStatus",payment_recorded as "paymentRecorded",return_count::text as "returnCount"
      from selected_orders where ${after} order by created_at desc,id desc limit ${query.limit + l.one}`);
    const items = result.rows.slice(l.zero, query.limit).map(row => project(adminOrderSummarySchema, {
      id: row.id, orderNumber: row.orderNumber, brand: {id: row.brandId, name: row.brandName}, status: row.status,
      createdAt: row.createdAt, totalAmount: integer(row.totalAmount), currency: row.currency, itemCount: integer(row.itemCount),
      shipmentStatus: row.shipmentStatus, paymentRecorded: row.paymentRecorded, returnCount: integer(row.returnCount),
    }));
    return project(adminOrderPageSchema, {items, nextCursor: result.rows.length > query.limit ? items.at(-l.one)!.id : null,
      totalCount: integer(meta.count), revision: meta.revision, asOf: meta.asOf, currencies: meta.currencies});
  }
  async detail(id: string): Promise<AdminOrderDetail | undefined> {
    const order = await new DrizzleOrderRepository(this.database).findById(id);
    if (!order) return undefined;
    const [brand] = await this.database.db.select({id: brandProfiles.id, name: brandProfiles.brandName}).from(brandProfiles).where(eq(brandProfiles.id, order.brandId));
    if (!brand || !brand.name.trim()) throw new ConflictException(A.failure.persisted);
    const records = await this.database.db.select({id: payments.id, provider: payments.provider, status: payments.status, amount: payments.amount,
      currency: payments.currency, providerPaymentIntentId: payments.providerPaymentIntentId, createdAt: payments.createdAt, updatedAt: payments.updatedAt})
      .from(payments).where(eq(payments.orderId, id)).orderBy(payments.createdAt, payments.id);
    const paymentRecords = records.map(row => project(adminOrderPaymentSchema, {...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString()}));
    if (paymentRecords.some(payment => payment.currency !== order.currency || payment.amount !== order.totalAmount)) throw new ConflictException(A.failure.persisted);
    const metadata = await this.database.db.execute(sql`select count(*)::text as count,${asOf} as "asOf" from ${orderReturns} where order_id=${id}`);
    return {order, brand, payments: paymentRecords, returnCount: integer(metadata.rows[l.zero].count), asOf: String(metadata.rows[l.zero].asOf)};
  }
  relatedReturns(actorId: string, id: string, query: AdminOrderReturnsQuery) {
    return new DrizzleOrderReturnRepository(this.database).list({kind: RETURN_ACTOR.administrator}, actorId, {...query, orderId: id});
  }
}
function integer(value: unknown): number {
  const result = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isSafeInteger(result) || result < l.zero) throw new ConflictException(A.failure.persisted);
  return result;
}
function project<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ConflictException(A.failure.persisted);
  return result.data;
}
