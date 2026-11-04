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
  const rule = {resolve: async () => ({id: "rule-revision-1", creatorGradeCode: "seed", rateBps: 1200})};
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
    const service = new OrdersService(new FakeOrderRepository(), snapshots, rule);

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
  it('prepares the same immutable item terms and rounded creator commission without saving an order', async () => {
    const repository = new FakeOrderRepository();
    const snapshots: ProductSnapshotReader = {buildSnapshot: async () => ({name: 'Prepared sale qualification'})};
    const service = new OrdersService(repository,snapshots,rule);
    const prepared = await service.prepareCartSale(cart);
    expect(prepared.creatorCommissionAmount).toBe(1200);
    expect(prepared.items).toHaveLength(1);
    expect(prepared.items[0]).toMatchObject({productId:'product-1',commissionRate:0.12,totalPrice:10000});
    expect(prepared.items[0]).not.toHaveProperty('id');
    expect((await repository.listForCustomer(cart.userId,20)).items).toEqual([]);
  });
  it('rounds each creator item before checking the sale budget, matching the persisted item calculation', async () => {
    const rounding = {price:5,rateBps:1000,quantity:1,expected:2,first:'variant-rounding-first',second:'variant-rounding-second'};
    const service = new OrdersService(new FakeOrderRepository(),{buildSnapshot:async()=>({name:'Rounding qualification'})},
      {resolve:async()=>({...await rule.resolve(),rateBps:rounding.rateBps})});
    const items = [rounding.first,rounding.second].map(id=>({...cart.items[0],id,productVariantId:id,
      quantity:rounding.quantity,unitPrice:rounding.price}));
    expect((await service.prepareCartSale({...cart,items})).creatorCommissionAmount).toBe(rounding.expected);
  });
  it('does not require or invent a creator commission for a direct purchase', async () => {
    const service = new OrdersService(new FakeOrderRepository(),{buildSnapshot:async()=>({name:'Direct sale qualification'})},
      {resolve:async()=>{throw new Error('No creator rule is applicable to this direct purchase');}});
    const item={...cart.items[0],sourceCreatorId:undefined,sourceOutfitId:undefined};
    const prepared=await service.prepareCartSale({...cart,sourceCreatorId:undefined,sourceOutfitId:undefined,items:[item]});
    expect(prepared.creatorCommissionAmount).toBe(0);expect(prepared.items[0].commissionRate).toBe(0);
  });

  it("does not expose customer shipping address in creator order views", async () => {
    const service = new OrdersService(new FakeOrderRepository(), {
      buildSnapshot: async () => ({}),
    }, rule);
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
          id: "rule-revision-1", creatorGradeCode: "seed", rateBps: 1200,
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
    expect(order.items[0]?.commissionRuleId).toBe("rule-revision-1");
    expect(order.items[0]?.commissionCreatorGradeCode).toBe("seed");
  });
});
