import {cancellationSettlementMap} from './refund-proof-projection';
import {projectCancellation} from './cancellation-projection';
import {BadRequestException, ConflictException, Inject, Injectable} from '@nestjs/common';
import {and, desc, eq, inArray, lt, or} from 'drizzle-orm';
import {DatabaseService} from '../../../shared/infrastructure/database/database.service';
import {READ_SNAPSHOT, type DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {orders, orderItems, shipments, orderCancellations, orderCancellationRefunds, type OrderRow, type OrderItemRow, type ShipmentRow} from '../../../shared/infrastructure/database/schema';
import {DrizzleBrandsRepository} from '../../brands/drizzle-brands.repository';
import {projectShipment} from '../../shipping/infrastructure/shipment-projection';
import {shipmentActions} from '../../shipping/domain/shipping.contract';
import {BRAND_ORDERS, type BrandOrderDetail, type BrandOrderQuery, type BrandOrderSummary} from '../domain/brand-order.contract';
import type {BrandOrderRepository} from '../domain/brand-order.repository';
import {ORDER_LIMIT, type OrderStatus} from '../domain/order-lifecycle';
import {shippingAddressSchema} from '../domain/shipping-address';
import {projectFrozenOrderItem} from './frozen-order-item';


@Injectable()
export class DrizzleBrandOrdersRepository implements BrandOrderRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseSession) {}
  snapshot<T>(operation: (repository: BrandOrderRepository) => Promise<T>): Promise<T> {
    return this.database.db.transaction(tx => operation(new DrizzleBrandOrdersRepository({db: tx})), READ_SNAPSHOT);
  }
  findManagementAccess(brandId: string, actorId: string) { return new DrizzleBrandsRepository(this.database).findManagementAccess(brandId, actorId); }
  async list(brandId: string, query: BrandOrderQuery) {
    let anchor: OrderRow | undefined;
    if (query.cursor) {
      [anchor] = await this.database.db.select().from(orders)
        .where(and(eq(orders.id, query.cursor), eq(orders.brandId, brandId), inArray(orders.status, BRAND_ORDERS.visibleStatuses)))
        .limit(ORDER_LIMIT.singleRow);
      if (!anchor) throw new BadRequestException(BRAND_ORDERS.failure.cursor);
    }
    const rows = await this.database.db.select().from(orders).where(and(eq(orders.brandId, brandId),
      inArray(orders.status, BRAND_ORDERS.visibleStatuses), query.status ? eq(orders.status, query.status) : undefined,
      anchor ? or(lt(orders.createdAt, anchor.createdAt), and(eq(orders.createdAt, anchor.createdAt), lt(orders.id, anchor.id))) : undefined))
      .orderBy(desc(orders.createdAt), desc(orders.id)).limit(query.limit + ORDER_LIMIT.overflow);
    const selected = rows.slice(ORDER_LIMIT.firstRow, query.limit), ids = selected.map(row => row.id);
    if (!ids.length) return {items: [], nextCursor: null};
    const [items, shipping] = await Promise.all([
      this.database.db.select().from(orderItems).where(inArray(orderItems.orderId, ids)),
      this.database.db.select().from(shipments).where(inArray(shipments.orderId, ids)),
    ]);
    return {items: selected.map(row => projectSummary(row, items.filter(item => item.orderId === row.id), shipping.find(value => value.orderId === row.id))),
      nextCursor: rows.length > query.limit ? selected.at(ORDER_LIMIT.lastRow)!.id : null};
  }
  async detail(brandId: string, id: string): Promise<BrandOrderDetail | undefined> {
    const [row] = await this.database.db.select().from(orders).where(and(eq(orders.id, id), eq(orders.brandId, brandId), inArray(orders.status, BRAND_ORDERS.visibleStatuses))).limit(ORDER_LIMIT.singleRow);
    if (!row) return undefined;
    const [items, [shipping], [cancellation], [refund],external] = await Promise.all([
      this.database.db.select().from(orderItems).where(eq(orderItems.orderId, id)).orderBy(orderItems.id),
      this.database.db.select().from(shipments).where(eq(shipments.orderId, id)).limit(ORDER_LIMIT.singleRow),
      this.database.db.select().from(orderCancellations).where(eq(orderCancellations.orderId, id)).limit(ORDER_LIMIT.singleRow),
      this.database.db.select().from(orderCancellationRefunds).innerJoin(orderCancellations, eq(orderCancellations.id, orderCancellationRefunds.cancellationId))
        .where(eq(orderCancellations.orderId, id)).orderBy(desc(orderCancellationRefunds.attemptNumber)).limit(ORDER_LIMIT.singleRow),
      cancellationSettlementMap(this.database,[id]),
    ]);
    const address = shippingAddressSchema.safeParse(row.shippingAddress);
    if (!address.success || (shipping && shipping.brandId !== row.brandId)) throw new ConflictException(BRAND_ORDERS.failure.persisted);
    const shipment = shipping ? projectShipment(shipping) : null;
    return {...projectSummary(row, items, shipping), subtotalAmount: row.subtotalAmount, shippingAmount: row.shippingAmount, taxAmount: row.taxAmount,
      cancellation: cancellation ? projectCancellation(cancellation, refund?.order_cancellation_refunds,external.get(id) ?? null) : null, shippingAddress: address.data, items: items.map(item => projectFrozenOrderItem(item, BRAND_ORDERS.failure.persisted)), shipment, actions: shipment ? shipmentActions({shipment, orderStatus: row.status as OrderStatus}) : []};
  }
}
function projectSummary(row: OrderRow, items: OrderItemRow[], shipping?: ShipmentRow): BrandOrderSummary {
  return {id: row.id, orderNumber: row.orderNumber, brandId: row.brandId, status: row.status as OrderStatus, createdAt: row.createdAt.toISOString(),
    totalAmount: row.totalAmount, currency: row.currency, itemCount: items.reduce<number>((count, item) => count + item.quantity, ORDER_LIMIT.initialQuantity),
    shipmentStatus: shipping ? projectShipment(shipping).status : null};
}
