import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CreateEditorialCollectionDto } from '../application/dto/editorial.dto';
import { EditorialService } from '../application/editorial.service';

@Controller('editorial')
export class EditorialController {
  constructor(private readonly editorialService: EditorialService) {}

  @Post('collections')
  createCollection(@Body() body: CreateEditorialCollectionDto) {
    return this.editorialService.createCollection(body);
  }

  @Patch('collections/:id/publish')
  publishCollection(@Param('id') id: string) {
    return this.editorialService.publishCollection(id);
  }

  @Get('collections')
  getPublicCollections(@Query('limit') limit?: string) {
    return this.editorialService.getPublicCollections(limit ? Number(limit) : undefined);
  }
}
