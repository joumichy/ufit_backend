import {Controller, Get, Inject, Param, ParseUUIDPipe} from '@nestjs/common';
import {CreatorsService} from './creators.service';
import {PUBLIC_CREATOR} from './public-creator.contract';

@Controller(PUBLIC_CREATOR.root)
export class PublicCreatorsController {
  constructor(@Inject(CreatorsService) private readonly creators: CreatorsService) {}
  @Get(PUBLIC_CREATOR.profile)
  get(@Param(PUBLIC_CREATOR.id, ParseUUIDPipe) id: string) { return this.creators.getPublicProfile(id); }
}
