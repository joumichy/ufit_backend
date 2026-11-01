import { CartQuoteService } from '../application/cart-quote.service';
import { Body, Controller, Delete, Get, Inject, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../../shared/presentation/decorators/current-user.decorator';
import { AuthGuard } from '../../../shared/presentation/guards/auth.guard';
import type { AuthenticatedUser } from '../../identity/domain/user.types';
import { CartService } from '../application/cart.service';

import { AddCartItemRequest, UpdateCartQuantityRequest } from './dto/cart.request';

@Controller('cart')
@UseGuards(AuthGuard)
export class CartController {
  constructor(@Inject(CartService) private readonly cartService: CartService, @Inject(CartQuoteService) private readonly quotes: CartQuoteService) {}

  @Post('quote')
  quote(@CurrentUser() user: AuthenticatedUser, @Body() body: {country?: unknown}) { return this.quotes.quote(user.id,body.country); }

  @Get()
  get(@CurrentUser() user: AuthenticatedUser) {
    return this.cartService.getActive(user.id);
  }

  @Patch('items/:id')
  update(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateCartQuantityRequest) {
    return this.cartService.setQuantity(user.id, id, body.quantity);
  }

  @Delete('items/:id')
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.cartService.removeItem(user.id, id);
  }

  @Delete()
  clear(@CurrentUser() user: AuthenticatedUser) {
    return this.cartService.clear(user.id);
  }

  @Post('items')
  async addItem(@CurrentUser() user: AuthenticatedUser, @Body() body: AddCartItemRequest) {
    return this.cartService.addItem({ ...body, userId: user.id });
  }
}
