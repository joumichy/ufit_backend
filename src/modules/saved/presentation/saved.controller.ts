import { Controller, Delete, Get, Inject, Param, ParseUUIDPipe, Put, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../../shared/presentation/decorators/current-user.decorator';
import { AuthGuard } from '../../../shared/presentation/guards/auth.guard';
import type { AuthenticatedUser } from '../../identity/domain/user.types';
import { SavedService } from '../application/saved.service';
import {SAVED_OUTFITS} from '../domain/saved-outfits.contract';

const creatorFollowRoute = {path: 'creator-follows/:creatorId', id: 'creatorId'} as const;

@Controller('me')
@UseGuards(AuthGuard)
export class SavedController {
  constructor(@Inject(SavedService) private readonly savedService: SavedService) {}

  @Put(SAVED_OUTFITS.routes.outfit)
  saveOutfit(@CurrentUser() user: AuthenticatedUser, @Param(SAVED_OUTFITS.routes.id, ParseUUIDPipe) outfitId: string) {
    return this.savedService.saveOutfit(user.id, outfitId);
  }

  @Get(SAVED_OUTFITS.routes.collection)
  listSavedOutfits(@CurrentUser() user: AuthenticatedUser, @Query() query: Record<string, unknown>) {
    return this.savedService.listSavedOutfits(user.id, query);
  }
  @Get(SAVED_OUTFITS.routes.states)
  savedOutfitStates(@CurrentUser() user: AuthenticatedUser, @Query() query: Record<string, unknown>) {
    return this.savedService.savedOutfitStates(user.id, query);
  }
  @Delete(SAVED_OUTFITS.routes.outfit)
  unsaveOutfit(@CurrentUser() user: AuthenticatedUser, @Param(SAVED_OUTFITS.routes.id, ParseUUIDPipe) outfitId: string) {
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
