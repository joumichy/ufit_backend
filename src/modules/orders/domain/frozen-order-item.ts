export interface FrozenOrderItem {
  id: string; productId: string; productVariantId: string; name: string; sku: string;
  size: string | null; color: string | null; imageUrl: string | null;
  quantity: number; unitPrice: number; totalPrice: number;
}
