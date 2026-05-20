import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CreateOutfitDto, ReviewOutfitDto } from '../application/dto/outfit.dto';
import { OutfitsService } from '../application/outfits.service';

@Controller('outfits')
export class OutfitsController {
  constructor(private readonly outfitsService: OutfitsService) {}

  @Post()
  createOutfit(@Body() body: CreateOutfitDto) {
    return this.outfitsService.createOutfit(body);
  }

  @Patch(':id/submit')
  submitOutfit(@Param('id') id: string) {
    return this.outfitsService.submitOutfit(id);
  }

  @Patch(':id/review')
  reviewOutfit(@Param('id') id: string, @Body() body: ReviewOutfitDto) {
    return this.outfitsService.reviewOutfit(id, body);
  }

  @Get()
  getPublicFeed(@Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    return this.outfitsService.getPublicFeed({ limit: limit ? Number(limit) : undefined, cursor });
  }

  @Get(':id')
  getPublicDetail(@Param('id') id: string) {
    return this.outfitsService.getPublicDetail(id);
  }
}
