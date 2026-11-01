import {BRAND_ORDERS} from '../../../modules/orders/domain/brand-order.contract';
import {
  index,
  integer,
  jsonb,
  numeric,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { ufitSchema, timestamps } from "./schema-base";
import {
  users,
  carts,
  creatorProfiles,
  outfits,
  products,
  productVariants,
} from "./schema";
export const orders = ufitSchema.table(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderNumber: text("order_number").notNull().unique(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => users.id),
    brandId: uuid("brand_id").notNull(),
    sourceCreatorId: uuid("source_creator_id").references(
      () => creatorProfiles.id,
      { onDelete: "set null" },
    ),
    sourceOutfitId: uuid("source_outfit_id").references(() => outfits.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("pending_payment"),
    subtotalAmount: integer("subtotal_amount").notNull(),
    shippingAmount: integer("shipping_amount").notNull().default(0),
    taxAmount: integer("tax_amount").notNull().default(0),
    cartId: uuid("cart_id").references(() => carts.id),
    checkoutRequestId: uuid("checkout_request_id"),
    checkoutFingerprint: text("checkout_fingerprint"),
    commerceSnapshot:
      jsonb("commerce_snapshot").$type<Record<string, unknown>>(),
    totalAmount: integer("total_amount").notNull(),
    currency: text("currency").notNull().default("CHF"),
    shippingAddress: jsonb("shipping_address").notNull(),
    paymentProvider: text("payment_provider").notNull().default("placeholder"),
    stripeCheckoutSessionId: text("stripe_checkout_session_id"),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    ...timestamps,
  },
  (table) => ({
    checkoutRequestUnique: uniqueIndex(
      "orders_customer_checkout_request_unique",
    ).on(table.customerId, table.checkoutRequestId),
    customerIdIndex: index("orders_customer_id_idx").on(table.customerId),
    brandStatusIndex: index("orders_brand_id_status_idx").on(
      table.brandId,
      table.status,
    ),
    brandCreatedIndex: index(BRAND_ORDERS.index.brandCreated).on(table.brandId, table.createdAt.desc(), table.id.desc()),
    createdAtIndex: index("orders_created_at_idx").on(table.createdAt),
  }),
);

export const orderItems = ufitSchema.table(
  "order_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    productVariantId: uuid("product_variant_id")
      .notNull()
      .references(() => productVariants.id),
    productSnapshot: jsonb("product_snapshot").notNull(),
    quantity: integer("quantity").notNull(),
    unitPrice: integer("unit_price").notNull(),
    totalPrice: integer("total_price").notNull(),
    commissionRate: numeric("commission_rate", { precision: 5, scale: 4 })
      .notNull()
      .default("0"),
    sourceCreatorId: uuid("source_creator_id").references(
      () => creatorProfiles.id,
      { onDelete: "set null" },
    ),
    sourceOutfitId: uuid("source_outfit_id").references(() => outfits.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    orderIdIndex: index("order_items_order_id_idx").on(table.orderId),
  }),
);

export const orderStatusHistory = ufitSchema.table("order_status_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: uuid("order_id")
    .notNull()
    .references(() => orders.id, { onDelete: "cascade" }),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  changedBy: uuid("changed_by").references(() => users.id, {
    onDelete: "set null",
  }),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const orderCancellations = ufitSchema.table("order_cancellations", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: uuid("order_id")
    .notNull()
    .unique()
    .references(() => orders.id, { onDelete: "cascade" }),
  requestedBy: uuid("requested_by").references(() => users.id, {
    onDelete: "set null",
  }),
  originalStatus: text("original_status").notNull(),
  reason: text("reason").notNull(),
  nextRecoveryAt: timestamp("next_recovery_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  status: text("status").notNull(),
  paymentOutcome: text("payment_outcome"),
  stripeRefundId: text("stripe_refund_id").unique(),
  ...timestamps,
});
