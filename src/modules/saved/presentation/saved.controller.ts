import { Controller, Delete, Get, Inject, Param, Put, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../../shared/presentation/decorators/current-user.decorator';
import { AuthGuard } from '../../../shared/presentation/guards/auth.guard';
import type { AuthenticatedUser } from '../../identity/domain/user.types';
import { SavedService } from '../application/saved.service';

@Controller('me')
@UseGuards(AuthGuard)
export class SavedController {
  constructor(@Inject(SavedService) private readonly savedService: SavedService) {}

  @Put('saved-outfits/:outfitId')
  saveOutfit(@CurrentUser() user: AuthenticatedUser, @Param('outfitId') outfitId: string) {
    return this.savedService.saveOutfit(user.id, outfitId);
  }

  @Get('saved-outfits')
  listSavedOutfits(@CurrentUser() user: AuthenticatedUser, @Query('limit') limit?: string) {
    return this.savedService.listSavedOutfits(user.id, {
      limit: limit ? Number(limit) : undefined
    });
  }

  @Delete('saved-outfits/:outfitId')
  unsaveOutfit(@CurrentUser() user: AuthenticatedUser, @Param('outfitId') outfitId: string) {
    return this.savedService.unsaveOutfit(user.id, outfitId);
  }

  @Put('creator-follows/:creatorId')
  followCreator(@CurrentUser() user: AuthenticatedUser, @Param('creatorId') creatorId: string) {
    return this.savedService.followCreator(user.id, creatorId);
  }

  @Delete('creator-follows/:creatorId')
  unfollowCreator(@CurrentUser() user: AuthenticatedUser, @Param('creatorId') creatorId: string) {
    return this.savedService.unfollowCreator(user.id, creatorId);
  }
}
