import {CANCELLATION_REFUND} from '../../../modules/orders/domain/order-lifecycle';
import {BRAND_ORDERS} from '../../../modules/orders/domain/brand-order.contract';
import {ORDER_RETURN} from '../../../modules/orders/domain/order-return.contract';
import {sql} from 'drizzle-orm';
import {
  boolean,
  index,
  check,
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
  commissionRules,
  creatorGrades,
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
    returnPolicyCheck: check('orders_return_refund_policy_known', sql`(${table.commerceSnapshot} is null or (jsonb_typeof(${table.commerceSnapshot}) = 'object' and ${table.commerceSnapshot}->>'refundPolicyCode' = ${sql.raw("'" + ORDER_RETURN.policy.code + "'")})) is true`),
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
    commissionRuleId: uuid('commission_rule_id').references(() => commissionRules.id),
    commissionCreatorGradeCode: text('commission_creator_grade_code').references(() => creatorGrades.code),
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
    orderIdentityUnique: uniqueIndex("order_items_id_order_unique").on(table.id, table.orderId),
    commissionPair: check('order_items_commission_provenance_pair', sql`(${table.commissionRuleId} is null) = (${table.commissionCreatorGradeCode} is null)`),
    commissionRequired: check('order_items_attributed_commission_required', sql`${table.sourceCreatorId} is null or ${table.commissionRuleId} is not null`),
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
  effectsApplied: boolean("effects_applied").notNull().default(false),
  ...timestamps,
}, table => ({orderIdentity: uniqueIndex('order_cancellations_id_order_unique').on(table.id,table.orderId)}));


export const orderCancellationRefunds = ufitSchema.table('order_cancellation_refunds', {
  id: uuid('id').primaryKey().defaultRandom(),
  cancellationId: uuid('cancellation_id').notNull().references(() => orderCancellations.id, {onDelete: 'cascade'}),
  attemptNumber: integer('attempt_number').notNull(), paymentIntentId: text('payment_intent_id').notNull(),
  amount: integer('amount').notNull(), currency: text('currency').notNull(),
  state: text('state').notNull(), providerStatus: text('provider_status'), stripeRefundId: text('stripe_refund_id').unique(),
  ...timestamps,
}, table => ({
  attemptUnique: uniqueIndex('order_cancellation_refunds_attempt_unique').on(table.cancellationId, table.attemptNumber),
  amountCheck: check('order_cancellation_refunds_amount_valid', sql`${table.amount} > 0 and ${table.attemptNumber} >= ${CANCELLATION_REFUND.attempt.initial}`),
  currencyCheck: check('order_cancellation_refunds_currency_valid', sql`${table.currency} ~ '^[A-Z]{3}$'`),
  oneActive: uniqueIndex('order_cancellation_refunds_one_active').on(table.cancellationId).where(sql`${table.state} in (${sql.raw("'" + CANCELLATION_REFUND.state.queued + "','" + CANCELLATION_REFUND.state.pending + "'")})`),
  stateCheck: check('order_cancellation_refunds_state_valid', sql`${table.state} in (${sql.raw(Object.values(CANCELLATION_REFUND.state).map(value => `'${value}'`).join(','))})`),
  providerCheck: check('order_cancellation_refunds_provider_valid', sql`(
    (${table.state} in (${CANCELLATION_REFUND.state.queued}, ${CANCELLATION_REFUND.state.blocked}) and ${table.stripeRefundId} is null and ${table.providerStatus} is null)
    or (${table.stripeRefundId} is not null and (
      (${table.state} = ${CANCELLATION_REFUND.state.pending} and ${table.providerStatus} in (${CANCELLATION_REFUND.providerStatus.pending}, ${CANCELLATION_REFUND.providerStatus.requiresAction}))
      or (${table.state} = ${CANCELLATION_REFUND.state.succeeded} and ${table.providerStatus} = ${CANCELLATION_REFUND.providerStatus.succeeded})
      or (${table.state} = ${CANCELLATION_REFUND.state.failed} and ${table.providerStatus} in (${CANCELLATION_REFUND.providerStatus.failed}, ${CANCELLATION_REFUND.providerStatus.cancelled}))
    ))
  ) is true`),
}));
