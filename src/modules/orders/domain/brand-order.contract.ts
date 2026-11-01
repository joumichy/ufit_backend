import {ORDER_STATUS, type OrderStatus} from './order-lifecycle';
import type {ShippingAddressSnapshot} from './shipping-address';
import type {Shipment, ShipmentActionName, ShipmentStatus} from '../../shipping/domain/shipping.contract';

export const BRAND_ORDERS = {
  repository: 'BrandOrderRepository',
  route: {root: 'brands/:brandId/orders', brandId: 'brandId', id: 'id', detail: ':id'},
  roles: ['brand_owner', 'brand_manager', 'admin', 'super_admin'] as const,
  visibleStatuses: Object.values(ORDER_STATUS).filter(status => status !== ORDER_STATUS.pendingPayment),
  snapshot: {minimumText: 1},
  index: {brandCreated: 'orders_brand_created_id_idx'},
  failure: {
    missing: {code: 'brand_order_not_found', message: 'Order not found for this brand'},
    cursor: {code: 'brand_order_cursor_invalid', message: 'Invalid brand order cursor'},
    persisted: {code: 'brand_order_persisted_invalid', message: 'The stored order is inconsistent'},
  },
} as const;
export interface BrandOrderSummary {
  id: string; orderNumber: string; brandId: string; status: OrderStatus; createdAt: string;
  totalAmount: number; currency: string; itemCount: number; shipmentStatus: ShipmentStatus | null;
}
export interface BrandOrderItem {
  id: string; productId: string; productVariantId: string; name: string; sku: string;
  size: string | null; color: string | null; imageUrl: string | null; quantity: number; unitPrice: number; totalPrice: number;
}
export interface BrandOrderDetail extends BrandOrderSummary {
  subtotalAmount: number; shippingAmount: number; taxAmount: number;
  shippingAddress: ShippingAddressSnapshot; items: BrandOrderItem[]; shipment: Shipment | null; actions: ShipmentActionName[];
}
export interface BrandOrderPage {items: BrandOrderSummary[]; nextCursor: string | null}
export interface BrandOrderQuery {limit: number; cursor?: string; status?: OrderStatus}
