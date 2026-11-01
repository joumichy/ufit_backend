import { describe, expect, it } from "vitest";
import type { CartQuote } from "../../src/modules/cart/application/cart-quote.service";
import type { Cart } from "../../src/modules/cart/application/cart.service";
import {
  OrdersService,
  type Order,
  type OrderRepository,
  type ProductSnapshotReader,
} from "../../src/modules/orders/application/orders.service";
import { InMemoryOrderRepository } from "../../src/modules/orders/infrastructure/in-memory-orders.repository";
class FakeOrderRepository extends InMemoryOrderRepository {}

describe("OrdersService", () => {
  const cart: Cart = {
    id: "cart-1",
    userId: "customer-1",
    status: "active",
    brandId: "brand-1",
    sourceOutfitId: "outfit-1",
    sourceCreatorId: "creator-1",
    currency: "CHF",
    subtotalAmount: 0,
    items: [
      {
        id: "line-1",
        productId: "product-1",
        productVariantId: "variant-1",
        quantity: 2,
        unitPrice: 5000,
        currency: "CHF",
        brandId: "brand-1",
        sourceOutfitId: "outfit-1",
        sourceCreatorId: "creator-1",
      },
    ],
  };

  const terms = {
    quote: {
      cartId: cart.id,
      brandId: cart.brandId,
      country: "CH",
      currency: "CHF",
      subtotalAmount: 10000,
      shippingAmount: 0,
      taxAmount: 0,
      totalAmount: 10000,
      returnWindowDays: 30,
      returnPolicy: "Qualification",
      refundPolicyCode: 'proportional_tax_full_shipping_v1',
      taxNotice: "Qualification",
      customsNotice: "Qualification",
      pricesIncludeTaxes: true,
      fingerprint: "quote",
      items: [],
    } as CartQuote,
    requestId: "request",
    fingerprint: "fingerprint",
  };
  it("creates order items with immutable product snapshots", async () => {
    const snapshots: ProductSnapshotReader = {
      async buildSnapshot() {
        return {
          name: "Tailored Wool Coat",
          brand: "Maison Test",
          size: "M",
          color: "Black",
          imageUrl: "https://example.test/coat.jpg",
          commissionRate: 0.12,
        };
      },
    };
    const service = new OrdersService(new FakeOrderRepository(), snapshots);

    const order = await service.createPendingFromCart(
      cart,
      {
        fullName: "A Customer",
        line1: "1 Test Street",
        postalCode: "8000",
        city: "Zurich",
        country: "CH",
      },
      terms,
    );

    expect(order.status).toBe("pending_payment");
    expect(order.totalAmount).toBe(10000);
    expect(order.items[0]?.productSnapshot).toMatchObject({
      name: "Tailored Wool Coat",
      brand: "Maison Test",
      commissionRate: 0.12,
    });
  });

  it("does not expose customer shipping address in creator order views", async () => {
    const service = new OrdersService(new FakeOrderRepository(), {
      buildSnapshot: async () => ({}),
    });
    const order = await service.createPendingFromCart(
      cart,
      {
        fullName: "A Customer",
        line1: "1 Test Street",
        postalCode: "8000",
        city: "Zurich",
        country: "CH",
      },
      terms,
    );

    expect(service.toCreatorOrderView(order)).not.toHaveProperty(
      "shippingAddress",
    );
  });

  it("freezes the resolved commission rate in each order item", async () => {
    const service = new OrdersService(
      new FakeOrderRepository(),
      { buildSnapshot: async () => ({ commissionRate: 0.1 }) },
      {
        resolve: async () => ({
          baseRate: 0.1,
          bonusRate: 0.05,
          maxRate: 0.12,
        }),
      },
    );
    const order = await service.createPendingFromCart(
      cart,
      {
        fullName: "Qualification",
        line1: "Rue de test",
        postalCode: "1000",
        city: "Lausanne",
        country: "CH",
      },
      terms,
    );
    expect(order.items[0]?.commissionRate).toBe(0.12);
  });
});
