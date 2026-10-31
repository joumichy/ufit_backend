import { OUTFIT_REPOSITORY, type OutfitRepository } from '../../outfits/domain/outfit.types';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
const CART_FAILURE = {
  brand: { code: 'cart_brand_conflict', message: 'The cart contains a different brand' },
  currency: { code: 'cart_currency_conflict', message: 'The cart contains a different currency' },
  stock: { code: 'cart_insufficient_stock', message: 'Insufficient stock for this variant' },
  changed: { code: 'cart_changed', message: 'The cart changed while it was being priced' },
  attribution: { code: 'cart_invalid_attribution', message: 'The product does not belong to this published outfit' }
} as const;

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
  mutate(userId: string, update: (cart: Cart | undefined) => Cart | undefined): Promise<Cart | undefined>;
}

export interface ProductCatalogReader {
  getVariantQuote(productVariantId: string): Promise<ProductVariantQuote>;
}

export interface AddCartItemInput {
  userId: string;
  productVariantId: string;
  quantity: number;
  sourceOutfitId?: string;
}

@Injectable()
export class CartService {
  constructor(
    @Inject('CartRepository') private readonly carts: CartRepository,
    @Inject('ProductCatalogReader') private readonly catalog: ProductCatalogReader,
    @Inject(OUTFIT_REPOSITORY) private readonly outfits: Pick<OutfitRepository, 'findById'>
  ) {}

  async addItem(input: AddCartItemInput): Promise<Cart> {
    this.assertQuantity(input.quantity);
    const quote = await this.catalog.getVariantQuote(input.productVariantId);
    let sourceCreatorId: string | undefined;
    if (input.sourceOutfitId) {
      const source = await this.outfits.findById(input.sourceOutfitId);
      if (!source || source.outfit.status !== 'published' || !source.items.some(item => item.isShoppable && item.productId === quote.productId)) {
        throw new BadRequestException(CART_FAILURE.attribution);
      }
      sourceCreatorId = source.outfit.creatorId ?? undefined;
    }
    const result = await this.carts.mutate(input.userId, existingCart => {
      const cart = existingCart ?? { id: randomUUID(), userId: input.userId, status: 'active' as const,
        currency: quote.currency, subtotalAmount: 0, items: [] };
      if (cart.brandId && cart.brandId !== quote.brandId) throw new ConflictException(CART_FAILURE.brand);
      if (cart.currency !== quote.currency) throw new ConflictException(CART_FAILURE.currency);
      const alreadyRequested = cart.items.filter(item => item.productVariantId === quote.productVariantId)
        .reduce((total, item) => total + item.quantity, 0);
      if (alreadyRequested + input.quantity > quote.stockQuantity) throw new ConflictException(CART_FAILURE.stock);
      const line = cart.items.find(item => item.productVariantId === quote.productVariantId && item.sourceOutfitId === input.sourceOutfitId);
      if (line) { line.quantity += input.quantity; line.unitPrice = quote.unitPrice; }
      else { cart.items.push({id: randomUUID(), productId: quote.productId, productVariantId: quote.productVariantId,
        quantity: input.quantity, unitPrice: quote.unitPrice, currency: quote.currency, brandId: quote.brandId,
        sourceOutfitId: input.sourceOutfitId, sourceCreatorId}); }
      cart.brandId = quote.brandId;
      cart.sourceOutfitId ??= input.sourceOutfitId;
      cart.sourceCreatorId ??= sourceCreatorId;
      this.updateSubtotal(cart);
      return cart;
    });
    return result!;
  }

  async getActive(userId: string): Promise<{ cart: Cart | null }> {
    return {cart: (await this.carts.findActiveByUserId(userId)) ?? null};
  }

  async setQuantity(userId: string, itemId: string, quantity: number): Promise<Cart> {
    this.assertQuantity(quantity);
    const snapshot = await this.requireOwnedCart(userId);
    const line = snapshot.items.find(item => item.id === itemId);
    if (!line) throw new NotFoundException('Cart item not found');
    const quote = await this.catalog.getVariantQuote(line.productVariantId);
    const result = await this.carts.mutate(userId, cart => {
      if (!cart) throw new NotFoundException('Cart not found');
      const item = cart.items.find(item => item.id === itemId);
      if (!item) throw new NotFoundException('Cart item not found');
      const otherQuantity = cart.items.filter(other => other.id !== itemId && other.productVariantId === item.productVariantId)
        .reduce((total, other) => total + other.quantity, 0);
      if (otherQuantity + quantity > quote.stockQuantity) throw new ConflictException(CART_FAILURE.stock);
      item.quantity = quantity; item.unitPrice = quote.unitPrice;
      this.updateSubtotal(cart);
      return cart;
    });
    return result!;
  }

  async removeItem(userId: string, itemId: string): Promise<Cart> {
    const result = await this.carts.mutate(userId, cart => {
      if (!cart || !cart.items.some(item => item.id === itemId)) throw new NotFoundException('Cart item not found');
      cart.items = cart.items.filter(item => item.id !== itemId);
      if (!cart.items.length) {
        cart.status = 'abandoned'; cart.brandId = undefined;
        cart.sourceCreatorId = undefined; cart.sourceOutfitId = undefined;
      }
      this.updateSubtotal(cart);
      return cart;
    });
    return result!;
  }

  async clear(userId: string): Promise<{ cart: null }> {
    await this.carts.mutate(userId, cart => { if (cart) cart.status = 'abandoned'; return cart; });
    return {cart: null};
  }

  async getActiveForCheckout(userId: string): Promise<Cart> {
    const snapshot = await this.requireOwnedCart(userId);
    if (!snapshot.brandId || !snapshot.items.length) throw new BadRequestException('Cannot checkout an empty cart');
    const quotes = new Map<string, ProductVariantQuote>();
    for (const line of snapshot.items) {
      if (!quotes.has(line.productVariantId)) quotes.set(line.productVariantId, await this.catalog.getVariantQuote(line.productVariantId));
    }
    const result = await this.carts.mutate(userId, cart => {
      if (!cart || this.contentRevision(cart) !== this.contentRevision(snapshot)) throw new ConflictException(CART_FAILURE.changed);
      const quantities = new Map<string, number>();
      for (const line of cart.items) quantities.set(line.productVariantId, (quantities.get(line.productVariantId) ?? 0) + line.quantity);
      for (const line of cart.items) {
        const quote = quotes.get(line.productVariantId)!;
        if (quote.brandId !== cart.brandId || quote.currency !== cart.currency || quote.stockQuantity < quantities.get(line.productVariantId)!) {
          throw new ConflictException(CART_FAILURE.stock);
        }
        line.unitPrice = quote.unitPrice;
      }
      this.updateSubtotal(cart);
      return cart;
    });
    return result!;
  }

  private contentRevision(cart: Cart): string {
    return JSON.stringify({id: cart.id, brand: cart.brandId, currency: cart.currency,
      items: [...cart.items].sort((a,b) => a.id.localeCompare(b.id)).map(item => ({id:item.id, variant:item.productVariantId, quantity:item.quantity}))});
  }
  private async requireOwnedCart(userId: string): Promise<Cart> {
    const cart = await this.carts.findActiveByUserId(userId);
    if (!cart) throw new NotFoundException('Cart not found');
    return cart;
  }
  private assertQuantity(quantity: number): void {
    if (!Number.isInteger(quantity) || quantity <= 0) throw new BadRequestException('Cart quantity must be a positive integer');
  }
  private updateSubtotal(cart: Cart): void { cart.subtotalAmount = cart.items.reduce((sum,line) => sum + line.unitPrice * line.quantity, 0); }
}
