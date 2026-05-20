import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

export interface CartLine {
  id: string;
  productId: string;
  productVariantId: string;
  quantity: number;
  unitPrice: number;
  currency: string;
  brandId: string;
  sourceOutfitId?: string;
  sourceCreatorId?: string;
}

export interface Cart {
  id: string;
  userId: string;
  status: 'active' | 'checked_out' | 'abandoned';
  brandId?: string;
  sourceOutfitId?: string;
  sourceCreatorId?: string;
  currency: string;
  subtotalAmount: number;
  items: CartLine[];
}

export interface ProductVariantQuote {
  productId: string;
  productVariantId: string;
  brandId: string;
  unitPrice: number;
  currency: string;
  stockQuantity: number;
}

export interface CartRepository {
  findActiveByUserId(userId: string): Promise<Cart | undefined>;
  save(cart: Cart): Promise<Cart>;
}

export interface ProductCatalogReader {
  getVariantQuote(productVariantId: string): Promise<ProductVariantQuote>;
}

export interface AddCartItemInput {
  userId: string;
  productVariantId: string;
  quantity: number;
  sourceOutfitId?: string;
  sourceCreatorId?: string;
}

@Injectable()
export class CartService {
  constructor(
    @Inject('CartRepository')
    private readonly carts: CartRepository,
    @Inject('ProductCatalogReader')
    private readonly catalog: ProductCatalogReader
  ) {}

  async addItem(input: AddCartItemInput): Promise<Cart> {
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
      throw new BadRequestException('Cart quantity must be a positive integer');
    }

    const quote = await this.catalog.getVariantQuote(input.productVariantId);
    if (quote.stockQuantity < input.quantity) {
      throw new BadRequestException('Insufficient stock for this variant');
    }

    const cart = (await this.carts.findActiveByUserId(input.userId)) ?? {
      id: randomUUID(),
      userId: input.userId,
      status: 'active' as const,
      currency: quote.currency,
      subtotalAmount: 0,
      items: []
    };

    if (cart.brandId && cart.brandId !== quote.brandId) {
      throw new BadRequestException('UFit MVP carts are mono-brand');
    }
    if (cart.currency !== quote.currency) {
      throw new BadRequestException('Cart currency cannot mix currencies');
    }

    const existing = cart.items.find(
      (item) => item.productVariantId === quote.productVariantId && item.sourceOutfitId === input.sourceOutfitId
    );
    if (existing) {
      const nextQuantity = existing.quantity + input.quantity;
      if (quote.stockQuantity < nextQuantity) {
        throw new BadRequestException('Insufficient stock for this variant');
      }
      existing.quantity = nextQuantity;
      existing.unitPrice = quote.unitPrice;
    } else {
      cart.items.push({
        id: randomUUID(),
        productId: quote.productId,
        productVariantId: quote.productVariantId,
        quantity: input.quantity,
        unitPrice: quote.unitPrice,
        currency: quote.currency,
        brandId: quote.brandId,
        sourceOutfitId: input.sourceOutfitId,
        sourceCreatorId: input.sourceCreatorId
      });
    }

    cart.brandId = quote.brandId;
    cart.sourceOutfitId ??= input.sourceOutfitId;
    cart.sourceCreatorId ??= input.sourceCreatorId;
    cart.subtotalAmount = cart.items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);

    return this.carts.save(cart);
  }
}
