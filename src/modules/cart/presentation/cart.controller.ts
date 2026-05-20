import { Body, Controller, Inject, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../../shared/presentation/decorators/current-user.decorator';
import { AuthGuard } from '../../../shared/presentation/guards/auth.guard';
import type { AuthenticatedUser } from '../../identity/domain/user.types';
import { CartService } from '../application/cart.service';

interface AddCartItemBody {
  productVariantId: string;
  quantity: number;
  sourceOutfitId?: string;
  sourceCreatorId?: string;
}

@Controller('cart')
@UseGuards(AuthGuard)
export class CartController {
  constructor(@Inject(CartService) private readonly cartService: CartService) {}

  @Post('items')
  async addItem(@CurrentUser() user: AuthenticatedUser, @Body() body: AddCartItemBody) {
    return this.cartService.addItem({ userId: user.id, ...body });
  }
}
