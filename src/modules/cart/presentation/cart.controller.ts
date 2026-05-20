import { Body, Controller, Headers, Post } from '@nestjs/common';
import { CartService } from '../application/cart.service';

interface AddCartItemBody {
  productVariantId: string;
  quantity: number;
  sourceOutfitId?: string;
  sourceCreatorId?: string;
}

@Controller('cart')
export class CartController {
  constructor(private readonly cartService: CartService) {}

  @Post('items')
  async addItem(@Headers('x-user-id') userId: string, @Body() body: AddCartItemBody) {
    return this.cartService.addItem({ userId, ...body });
  }
}
