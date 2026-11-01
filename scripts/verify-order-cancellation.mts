import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import { getEnv } from "../src/config/env";
import { DatabaseService } from "../src/shared/infrastructure/database/database.service";
import {
  commissions,
  orderCancellations,
  orderItems,
  orders,
  payments,
  products,
  productVariants,
  shipments,
  users,
} from "../src/shared/infrastructure/database/schema";
import { DrizzleOrderCancellationRepository } from "../src/modules/orders/infrastructure/drizzle-order-cancellation.repository";
import { DrizzleStripePaymentFinalizer } from "../src/modules/payments/infrastructure/drizzle-stripe-payment-finalizer";
import {
  CANCELLATION,
  ORDER_STATUS,
} from "../src/modules/orders/domain/order-lifecycle";

const fixture = {
  quantity: 2,
  rate: "0.1200",
  availableStock: 4,
  shortageLineCount: 2,
  second: 1,
  zero: 0,
  single: 1,
  cancelledShipmentVersion: 2,
  registry: homedir() + "/.codex/private/ufit/qualification.credentials.json",
  paymentPrefix: "pi_qualification_",
  eventPrefix: "evt_qualification_",
  refundPrefix: "re_qualification_",
  orderPrefix: "QUAL-CANCEL-",
  statuses: {
    payment: "refunded",
    commission: "cancelled",
    shipment: "cancelled",
  },
} as const;
const environment = getEnv();
if (
  environment.NODE_ENV !== "development" ||
  !environment.STRIPE_SECRET_KEY?.startsWith("sk_test_")
)
  throw new Error(
    "Order verification requires the selected development TEST profile",
  );
const registry = JSON.parse(await readFile(fixture.registry, "utf8"));
const database = new DatabaseService();
const createdIds: string[] = [];
class VerificationRollback extends Error {}
let passed = fixture.zero as number;
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
try {
  try {
    await database.db.transaction(async (tx) => {
      const [customer] = await tx
        .select()
        .from(users)
        .where(eq(users.email, registry.customer.email))
        .limit(fixture.single);
      const [product] = await tx
        .select()
        .from(products)
        .where(eq(products.id, registry.qualification.productIds[fixture.zero]))
        .limit(fixture.single);
      const [variant] = await tx
        .select()
        .from(productVariants)
        .where(eq(productVariants.productId, product.id))
        .limit(fixture.single)
        .for("update");
      assert(
        customer && variant.stockQuantity >= fixture.quantity,
        "Qualification stock is unavailable",
      );
      const startingStock = variant.stockQuantity;
      const nested = { db: tx } as unknown as DatabaseService;
      const cancellations = new DrizzleOrderCancellationRepository(nested);
      const finalizer = new DrizzleStripePaymentFinalizer(nested);
      async function create(
        status:
          | typeof ORDER_STATUS.paid
          | typeof ORDER_STATUS.pendingPayment
          | typeof ORDER_STATUS.preparing,
      ) {
        const id = randomUUID(),
          intent = fixture.paymentPrefix + randomUUID();
        createdIds.push(id);
        const [order] = await tx
          .insert(orders)
          .values({
            id,
            orderNumber: fixture.orderPrefix + id,
            customerId: customer.id,
            brandId: product.brandId,
            status,
            subtotalAmount: product.basePrice * fixture.quantity,
            shippingAmount: fixture.zero,
            totalAmount: product.basePrice * fixture.quantity,
            currency: product.currency,
            shippingAddress: {
              fullName: "Qualification",
              line1: "Adresse de qualification",
              city: "Lausanne",
              postalCode: "1000",
              country: "CH",
            },
            paymentProvider: "stripe",
            stripePaymentIntentId: intent,
          })
          .returning();
        const [item] = await tx
          .insert(orderItems)
          .values({
            orderId: id,
            productId: product.id,
            productVariantId: variant.id,
            productSnapshot: { name: product.name },
            quantity: fixture.quantity,
            unitPrice: product.basePrice,
            totalPrice: order.totalAmount,
            commissionRate: fixture.rate,
            sourceCreatorId: registry.creator.profileId,
            sourceOutfitId: registry.qualification.outfitId,
          })
          .returning();
        if (status !== ORDER_STATUS.pendingPayment) {
          await tx
            .update(productVariants)
            .set({
              stockQuantity: sql`${productVariants.stockQuantity}-${fixture.quantity}`,
            })
            .where(eq(productVariants.id, variant.id));
          await tx.insert(payments).values({
            orderId: id,
            provider: "stripe",
            providerPaymentIntentId: intent,
            status: "succeeded",
            amount: order.totalAmount,
            currency: order.currency,
          });
          await tx.insert(shipments).values({
            orderId: id,
            brandId: order.brandId,
            status: status === ORDER_STATUS.preparing ? "preparing" : "pending",
          });
          await tx.insert(commissions).values({
            orderItemId: item.id,
            creatorId: registry.creator.profileId,
            brandId: order.brandId,
            sourceOutfitId: registry.qualification.outfitId,
            baseAmount: order.totalAmount,
            commissionRate: fixture.rate,
            commissionAmount: Math.round(
              order.totalAmount * Number(fixture.rate),
            ),
            status: "pending",
          });
        }
        return { order, item };
      }
      const paid = await create(ORDER_STATUS.paid);
      const claim = await cancellations.claim(customer.id, paid.order.id);
      assert(
        (await cancellations.claim(customer.id, paid.order.id)).id === claim.id,
        "Duplicate cancellation claim",
      );
      const settlement = {
        outcome: CANCELLATION.outcome.refunded,
        refundId: fixture.refundPrefix + randomUUID(),
      };
      await cancellations.complete(claim, settlement);
      await cancellations.complete(claim, settlement);
      const [stock] = await tx
        .select()
        .from(productVariants)
        .where(eq(productVariants.id, variant.id));
      const [payment] = await tx
        .select()
        .from(payments)
        .where(eq(payments.orderId, paid.order.id));
      const [commission] = await tx
        .select()
        .from(commissions)
        .where(eq(commissions.orderItemId, paid.item.id));
      const [shipment] = await tx
        .select()
        .from(shipments)
        .where(eq(shipments.orderId, paid.order.id));
      assert(
        stock.stockQuantity === startingStock &&
          payment.status === fixture.statuses.payment &&
          commission.status === fixture.statuses.commission &&
          shipment.status === fixture.statuses.shipment &&
          shipment.version === fixture.cancelledShipmentVersion,
        "Cancellation did not reverse the paid order exactly once",
      );
      passed++;
      const pending = await create(ORDER_STATUS.pendingPayment);
      const pendingClaim = await cancellations.claim(
        customer.id,
        pending.order.id,
      );
      const confirmation = {
        eventId: fixture.eventPrefix + randomUUID(),
        orderId: pending.order.id,
        paymentIntentId: pending.order.stripePaymentIntentId!,
        amount: pending.order.totalAmount,
        currency: pending.order.currency,
      };
      await finalizer.confirm(confirmation);
      const replay = await finalizer.confirm(confirmation);
      const [pendingStock] = await tx
        .select()
        .from(productVariants)
        .where(eq(productVariants.id, variant.id));
      const [shipmentCount] = await tx
        .select({ value: count() })
        .from(shipments)
        .where(eq(shipments.orderId, pending.order.id));
      assert(
        replay.duplicate &&
          pendingStock.stockQuantity === startingStock &&
          shipmentCount.value === fixture.zero,
        "Late webhook fulfilled a cancelling order",
      );
      await cancellations.complete(pendingClaim, {
        outcome: CANCELLATION.outcome.refunded,
        refundId: fixture.refundPrefix + randomUUID(),
      });
      passed++;
      const preparing = await create(ORDER_STATUS.preparing);
      let refused = false;
      try {
        await cancellations.claim(customer.id, preparing.order.id);
      } catch (error) {
        refused =
          (error as { response?: { code?: string } }).response?.code ===
          CANCELLATION.failures.unavailable.code;
      }
      const [cancellationCount] = await tx
        .select({ value: count() })
        .from(orderCancellations)
        .where(eq(orderCancellations.orderId, preparing.order.id));
      assert(
        refused && cancellationCount.value === fixture.zero,
        "Preparation did not prevent cancellation",
      );
      passed++;
      const variants = await tx
        .select()
        .from(productVariants)
        .where(eq(productVariants.productId, product.id));
      const orderedVariants = [...variants].sort((a, b) =>
        a.id.localeCompare(b.id),
      );
      assert(
        orderedVariants.length > fixture.single,
        "Two qualification variants are required",
      );
      const available = orderedVariants[fixture.zero],
        unavailable = orderedVariants[fixture.second];
      await tx
        .update(productVariants)
        .set({ stockQuantity: fixture.availableStock })
        .where(eq(productVariants.id, available.id));
      await tx
        .update(productVariants)
        .set({ stockQuantity: fixture.zero })
        .where(eq(productVariants.id, unavailable.id));
      const short = await create(ORDER_STATUS.pendingPayment);
      const secondVariant =
        variant.id === available.id ? unavailable : available;
      await tx
        .insert(orderItems)
        .values({
          orderId: short.order.id,
          productId: product.id,
          productVariantId: secondVariant.id,
          productSnapshot: { name: product.name },
          quantity: fixture.quantity,
          unitPrice: product.basePrice,
          totalPrice: product.basePrice * fixture.quantity,
          commissionRate: fixture.rate,
        });
      const shortTotal =
        product.basePrice * fixture.quantity * fixture.shortageLineCount;
      await tx
        .update(orders)
        .set({ subtotalAmount: shortTotal, totalAmount: shortTotal })
        .where(eq(orders.id, short.order.id));
      const shortConfirmation = {
        eventId: fixture.eventPrefix + randomUUID(),
        orderId: short.order.id,
        paymentIntentId: short.order.stripePaymentIntentId!,
        amount: shortTotal,
        currency: short.order.currency,
      };
      const shortage = await finalizer.confirm(shortConfirmation);
      const shortageReplay = await finalizer.confirm(shortConfirmation);
      const stocks = await tx
        .select()
        .from(productVariants)
        .where(inArray(productVariants.id, [available.id, unavailable.id]));
      const [shortOrder] = await tx
        .select()
        .from(orders)
        .where(eq(orders.id, short.order.id));
      const [shortPayment] = await tx
        .select()
        .from(payments)
        .where(eq(payments.orderId, short.order.id));
      const [shortShipments] = await tx
        .select({ value: count() })
        .from(shipments)
        .where(eq(shipments.orderId, short.order.id));
      const [shortCommissions] = await tx
        .select({ value: count() })
        .from(commissions)
        .where(eq(commissions.orderItemId, short.item.id));
      const shortClaim = await cancellations.findPending(short.order.id);
      assert(
        shortage.reversalRequired &&
          shortageReplay.duplicate &&
          shortageReplay.reversalRequired &&
          shortOrder.status === ORDER_STATUS.cancelling &&
          shortPayment.status === "succeeded" &&
          shortShipments.value === fixture.zero &&
          shortCommissions.value === fixture.zero &&
          stocks.find((row) => row.id === available.id)?.stockQuantity ===
            fixture.availableStock &&
          stocks.find((row) => row.id === unavailable.id)?.stockQuantity ===
            fixture.zero &&
          shortClaim?.reason === CANCELLATION.reason.stockUnavailable,
        "Paid stock shortage did not preserve inventory and queue its refund",
      );
      passed++;
      const leased = await cancellations.claimRecoverable();
      const duplicateLease = await cancellations.claimRecoverable();
      assert(
        leased.some((row) => row.id === shortClaim.id) &&
          !duplicateLease.some((row) => row.id === shortClaim.id),
        "Recovery request was leased twice before expiry",
      );
      await cancellations.complete(shortClaim, {
        outcome: CANCELLATION.outcome.refunded,
        refundId: fixture.refundPrefix + randomUUID(),
      });
      const restored = await tx
        .select()
        .from(productVariants)
        .where(eq(productVariants.id, available.id));
      assert(
        restored[fixture.zero].stockQuantity === fixture.availableStock &&
          (await cancellations.findPending(short.order.id)) === null &&
          !(await finalizer.confirm(shortConfirmation)).reversalRequired,
        "Refund of an unfulfilled order changed stock or remained recoverable",
      );
      passed++;
      throw new VerificationRollback();
    });
  } catch (error) {
    if (!(error instanceof VerificationRollback)) throw error;
  }
  const [remaining] = await database.db
    .select({ value: count() })
    .from(orders)
    .where(inArray(orders.id, createdIds));
  assert(
    remaining.value === fixture.zero,
    "Verification transaction did not roll back",
  );
  console.log(
    JSON.stringify({
      repositoryScenarios: passed,
      persistedQualificationRows: remaining.value,
      checks: [
        "paid reversal exactly once",
        "late paid webhook during cancellation",
        "preparation prevents cancellation",
        "multi-variant stock savepoint and durable refund",
        "recovery lease and stock-neutral completion",
      ],
    }),
  );
} finally {
  await database.onModuleDestroy();
}
