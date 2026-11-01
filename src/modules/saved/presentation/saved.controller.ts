import { Controller, Delete, Get, Inject, Param, ParseUUIDPipe, Put, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../../shared/presentation/decorators/current-user.decorator';
import { AuthGuard } from '../../../shared/presentation/guards/auth.guard';
import type { AuthenticatedUser } from '../../identity/domain/user.types';
import { SavedService } from '../application/saved.service';

const creatorFollowRoute = {path: 'creator-follows/:creatorId', id: 'creatorId'} as const;

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

  @Put(creatorFollowRoute.path)
  followCreator(@CurrentUser() user: AuthenticatedUser, @Param(creatorFollowRoute.id, ParseUUIDPipe) creatorId: string) {
    return this.savedService.followCreator(user.id, creatorId);
  }

  @Delete(creatorFollowRoute.path)
  unfollowCreator(@CurrentUser() user: AuthenticatedUser, @Param(creatorFollowRoute.id, ParseUUIDPipe) creatorId: string) {
    return this.savedService.unfollowCreator(user.id, creatorId);
  }
  @Get(creatorFollowRoute.path)
  getCreatorFollow(@CurrentUser() user: AuthenticatedUser, @Param(creatorFollowRoute.id, ParseUUIDPipe) creatorId: string) {
    return this.savedService.getCreatorFollow(user.id, creatorId);
  }
}
