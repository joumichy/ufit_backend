import { Body, Controller, Get, Inject, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../../shared/presentation/decorators/current-user.decorator';
import { Roles } from '../../../shared/presentation/decorators/roles.decorator';
import { AuthGuard } from '../../../shared/presentation/guards/auth.guard';
import { RoleGuard } from '../../../shared/presentation/guards/role.guard';
import type { AuthenticatedUser } from '../../identity/domain/user.types';
import { CreateEditorialCollectionDto } from '../application/dto/editorial.dto';
import { EditorialService } from '../application/editorial.service';

@Controller('editorial')
export class EditorialController {
  constructor(@Inject(EditorialService) private readonly editorialService: EditorialService) {}

  @Post('collections')
  @UseGuards(AuthGuard, RoleGuard)
  @Roles('admin', 'super_admin')
  createCollection(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateEditorialCollectionDto) {
    return this.editorialService.createCollection({ ...body, createdBy: user.id });
  }

  @Patch('collections/:id/publish')
  @UseGuards(AuthGuard, RoleGuard)
  @Roles('admin', 'super_admin')
  publishCollection(@Param('id') id: string) {
    return this.editorialService.publishCollection(id);
  }

  @Get('collections')
  getPublicCollections(@Query('limit') limit?: string) {
    return this.editorialService.getPublicCollections(limit ? Number(limit) : undefined);
  }
}
