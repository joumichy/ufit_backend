import { Controller, Delete, Headers, Param, Put } from '@nestjs/common';
import { SavedService } from '../application/saved.service';

@Controller('me')
export class SavedController {
  constructor(private readonly savedService: SavedService) {}

  @Put('saved-outfits/:outfitId')
  saveOutfit(@Headers('x-user-id') userId: string, @Param('outfitId') outfitId: string) {
    return this.savedService.saveOutfit(userId, outfitId);
  }

  @Delete('saved-outfits/:outfitId')
  unsaveOutfit(@Headers('x-user-id') userId: string, @Param('outfitId') outfitId: string) {
    return this.savedService.unsaveOutfit(userId, outfitId);
  }

  @Put('creator-follows/:creatorId')
  followCreator(@Headers('x-user-id') userId: string, @Param('creatorId') creatorId: string) {
    return this.savedService.followCreator(userId, creatorId);
  }

  @Delete('creator-follows/:creatorId')
  unfollowCreator(@Headers('x-user-id') userId: string, @Param('creatorId') creatorId: string) {
    return this.savedService.unfollowCreator(userId, creatorId);
  }
}
