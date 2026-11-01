import {Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards} from '@nestjs/common';
import {CurrentUser} from '../../../shared/presentation/decorators/current-user.decorator';
import {AuthGuard} from '../../../shared/presentation/guards/auth.guard';
import {AdminGuard} from '../../../shared/presentation/guards/admin.guard';
import type {AuthenticatedUser} from '../../identity/domain/user.types';
import {CommissionRulesService} from '../application/commission-rules.service';
import {COMMISSION_RULE} from '../domain/commission-rule.contract';

@Controller(COMMISSION_RULE.route.admin)
@UseGuards(AuthGuard, AdminGuard)
export class CommissionRulesController {
  constructor(@Inject(CommissionRulesService) private readonly rules: CommissionRulesService) {}
  @Get()
  list(@CurrentUser() actor: AuthenticatedUser, @Query() query: unknown) {return this.rules.list(actor.id, query);}
  @Post()
  create(@CurrentUser() actor: AuthenticatedUser, @Body() body: unknown) {return this.rules.create(actor.id, body);}
  @Get(COMMISSION_RULE.route.history)
  history(@CurrentUser() actor: AuthenticatedUser, @Param(COMMISSION_RULE.route.scopeId, ParseUUIDPipe) id: string, @Query() query: unknown) {return this.rules.history(actor.id, id, query);}
  @Get(COMMISSION_RULE.route.scope)
  current(@CurrentUser() actor: AuthenticatedUser, @Param(COMMISSION_RULE.route.scopeId, ParseUUIDPipe) id: string) {return this.rules.current(actor.id, id);}
  @Post(COMMISSION_RULE.route.revisions)
  revise(@CurrentUser() actor: AuthenticatedUser, @Param(COMMISSION_RULE.route.scopeId, ParseUUIDPipe) id: string, @Body() body: unknown) {return this.rules.revise(actor.id, id, body);}
}
