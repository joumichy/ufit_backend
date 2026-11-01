import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { BrandCommerceService } from "../../brands/brand-commerce.service";
import { shippingCountrySchema } from "../../brands/commerce-policy";
import { CartService, type Cart, type CartLine } from "./cart.service";
import {ORDER_RETURN} from '../../orders/domain/order-return.contract';

const QUOTE_FAILURE = {
  country: {
    code: "shipping_country_invalid",
    message: "Invalid shipping country",
  },
  policy: {
    code: "brand_policy_missing",
    message: "The brand has not configured its shipping policy",
  },
  destination: {
    code: "shipping_unavailable",
    message: "The brand does not ship this currency to this country",
  },
  amount: {
    code: "quote_amount_invalid",
    message: "The order amount is outside the supported range",
  },
} as const;
const BASIS_POINTS = 10000n;
const HALF_BASIS_POINT = BASIS_POINTS / 2n;
export interface CartQuote {
  fingerprint: string;
  items: Array<
    Pick<
      CartLine,
      "id" | "productId" | "productVariantId" | "quantity" | "unitPrice"
    >
  >;
  cartId: string;
  brandId: string;
  country: string;
  currency: string;
  subtotalAmount: number;
  shippingAmount: number;
  taxAmount: number;
  totalAmount: number;
  returnWindowDays: number;
  returnPolicy: string;
  refundPolicyCode: typeof ORDER_RETURN.policy.code;
  pricesIncludeTaxes: boolean;
  taxNotice: string;
  customsNotice: string;
}
@Injectable()
export class CartQuoteService {
  constructor(
    @Inject(CartService) private readonly carts: CartService,
    @Inject(BrandCommerceService)
    private readonly commerce: BrandCommerceService,
  ) {}
  async quote(userID: string, country: unknown): Promise<CartQuote> {
    return (await this.prepare(userID, country)).quote;
  }
  async prepare(
    userID: string,
    country: unknown,
  ): Promise<{ cart: Cart; quote: CartQuote }> {
    const destination = shippingCountrySchema.safeParse(country);
    if (!destination.success)
      throw new BadRequestException(QUOTE_FAILURE.country);
    const cart = await this.carts.getActiveForCheckout(userID);
    const policy = await this.commerce.read(cart.brandId!);
    if (!policy) throw new ConflictException(QUOTE_FAILURE.policy);
    const rate = policy.shippingRates.find(
      (rate) =>
        rate.country === destination.data && rate.currency === cart.currency,
    );
    if (!rate) throw new ConflictException(QUOTE_FAILURE.destination);
    const taxable =
      BigInt(cart.subtotalAmount) +
      (rate.taxOnShipping ? BigInt(rate.amount) : 0n);
    const taxAmount = policy.pricesIncludeTaxes
      ? 0
      : Number(
          (taxable * BigInt(rate.taxBasisPoints) + HALF_BASIS_POINT) /
            BASIS_POINTS,
        );
    const totalAmount = cart.subtotalAmount + rate.amount + taxAmount;
    if (
      !Number.isSafeInteger(totalAmount) ||
      totalAmount <= 0 ||
      totalAmount > 2147483647
    )
      throw new BadRequestException(QUOTE_FAILURE.amount);
    const amounts = {
      cartId: cart.id,
      brandId: cart.brandId!,
      country: destination.data,
      currency: cart.currency,
      subtotalAmount: cart.subtotalAmount,
      shippingAmount: rate.amount,
      taxAmount,
      totalAmount,
      returnWindowDays: policy.returnWindowDays,
      returnPolicy: policy.returnPolicy,
      refundPolicyCode: ORDER_RETURN.policy.code,
      pricesIncludeTaxes: policy.pricesIncludeTaxes,
      taxNotice: policy.taxNotice,
      customsNotice: policy.customsNotice,
    };
    const lines = [...cart.items]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((item) => ({
        id: item.id,
        productId: item.productId,
        productVariantId: item.productVariantId,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
      }));
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ amounts, lines }))
      .digest("hex");
    return { cart, quote: { ...amounts, items: lines, fingerprint } };
  }
}
