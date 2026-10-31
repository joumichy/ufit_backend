import { describe, expect, it, vi } from "vitest";
import { CartQuoteService } from "../../src/modules/cart/application/cart-quote.service";
import { brandCommercePolicySchema } from "../../src/modules/brands/commerce-policy";
const cart = {
  id: "cart",
  brandId: "brand",
  currency: "CHF",
  subtotalAmount: 10005,
  items: [
    { id: "line", productVariantId: "variant", quantity: 1, unitPrice: 10005 },
  ],
};
const policy = {
  returnWindowDays: 30,
  returnPolicy: "Retours après livraison.",
  pricesIncludeTaxes: false,
  taxNotice: "Taxes ajoutées.",
  customsNotice: "Douane destinataire.",
  shippingRates: [
    {
      country: "CH",
      currency: "CHF",
      amount: 800,
      taxBasisPoints: 810,
      taxOnShipping: true,
    },
  ],
};
function setup(config: unknown = policy) {
  const commerce = { read: vi.fn().mockResolvedValue(config) };
  const service = new CartQuoteService(
    {
      getActiveForCheckout: vi.fn().mockResolvedValue(structuredClone(cart)),
    } as never,
    commerce as never,
  );
  return { service, commerce };
}
describe("CartQuoteService", () => {
  it("prices shipping and rounded additional tax in minor units", async () => {
    const { service } = setup();
    expect(await service.quote("customer", "CH")).toMatchObject({
      subtotalAmount: 10005,
      shippingAmount: 800,
      taxAmount: 875,
      totalAmount: 11680,
      currency: "CHF",
    });
  });
  it("does not add tax twice for tax-inclusive prices", async () => {
    const { service } = setup({ ...policy, pricesIncludeTaxes: true });
    expect(await service.quote("customer", "CH")).toMatchObject({
      taxAmount: 0,
      totalAmount: 10805,
    });
  });
  it("rejects a missing policy and an unsupported destination", async () => {
    await expect(
      setup(null).service.quote("customer", "CH"),
    ).rejects.toMatchObject({ response: { code: "brand_policy_missing" } });
    await expect(setup().service.quote("customer", "US")).rejects.toMatchObject(
      { response: { code: "shipping_unavailable" } },
    );
  });
  it("rejects an invalid country before any policy lookup", async () => {
    const { service, commerce } = setup();
    await expect(service.quote("customer", "ch")).rejects.toMatchObject({
      status: 400,
    });
    expect(commerce.read).not.toHaveBeenCalled();
  });
  it("changes the acceptance fingerprint when a policy changes", async () => {
    const a = await setup().service.quote("customer", "CH");
    const b = await setup({ ...policy, returnWindowDays: 14 }).service.quote(
      "customer",
      "CH",
    );
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
  it("rejects duplicate country/currency rates and unrecognized policy fields", () => {
    expect(
      brandCommercePolicySchema.safeParse({
        ...policy,
        shippingRates: [...policy.shippingRates, ...policy.shippingRates],
      }).success,
    ).toBe(false);
    expect(
      brandCommercePolicySchema.safeParse({ ...policy, unrecognized: true })
        .success,
    ).toBe(false);
  });
});
