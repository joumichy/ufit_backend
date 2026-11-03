import {BadRequestException, Body, Controller, Get, Inject, Param, Post, Query, UseGuards} from '@nestjs/common';
import {AuthGuard} from '../../../shared/presentation/guards/auth.guard';
import {RoleGuard} from '../../../shared/presentation/guards/role.guard';
import {CurrentUser} from '../../../shared/presentation/decorators/current-user.decorator';
import {Roles} from '../../../shared/presentation/decorators/roles.decorator';
import type {AuthenticatedUser} from '../../identity/domain/user.types';
import {REFUND_RECOVERY as R} from '../domain/refund-recovery.contract';
import {REFUND_ORGANIZATION as O, refundOrganizationScopeSchema} from '../domain/refund-organization';
import {RefundOrganizationService} from '../application/refund-organization.service';

@Controller(O.route.admin) @UseGuards(AuthGuard,RoleGuard) @Roles(...R.roles)
export class AdminRefundOrganizationController {
  constructor(@Inject(RefundOrganizationService) private readonly organizations:RefundOrganizationService) {}
  @Get(O.route.organization)
  read(@CurrentUser() user:AuthenticatedUser,@Param(R.route.kind) kind:string,@Param(R.route.id) id:string) {
    return this.organizations.read({scope:O.scope.administrator,actorId:user.id},kind,id);
  }
  @Post(O.route.organization)
  apply(@CurrentUser() user:AuthenticatedUser,@Param(R.route.kind) kind:string,@Param(R.route.id) id:string,@Body() body:unknown) {
    return this.organizations.apply({scope:O.scope.administrator,actorId:user.id},kind,id,body);
  }
  @Get(O.route.command)
  receipt(@CurrentUser() user:AuthenticatedUser,@Param(R.route.kind) kind:string,@Param(R.route.id) id:string,@Param(O.route.requestId) requestId:string) {
    return this.organizations.receipt({scope:O.scope.administrator,actorId:user.id},kind,id,requestId);
  }
}
@Controller(O.route.private) @UseGuards(AuthGuard)
export class PrivateRefundOrganizationController {
  constructor(@Inject(RefundOrganizationService) private readonly organizations:RefundOrganizationService) {}
  @Get(O.route.organization)
  read(@CurrentUser() user:AuthenticatedUser,@Param(R.route.kind) kind:string,@Param(R.route.id) id:string,@Query() raw:unknown) {
    const query=refundOrganizationScopeSchema.safeParse(raw);
    if(!query.success) throw new BadRequestException(O.failure.input);
    return this.organizations.read({scope:query.data.scope,actorId:user.id},kind,id);
  }
  @Post(O.route.organization)
  apply(@CurrentUser() user:AuthenticatedUser,@Param(R.route.kind) kind:string,@Param(R.route.id) id:string,@Body() body:unknown) {
    return this.organizations.apply({scope:O.scope.customer,actorId:user.id},kind,id,body);
  }
  @Get(O.route.command)
  receipt(@CurrentUser() user:AuthenticatedUser,@Param(R.route.kind) kind:string,@Param(R.route.id) id:string,@Param(O.route.requestId) requestId:string) {
    return this.organizations.receipt({scope:O.scope.customer,actorId:user.id},kind,id,requestId);
  }
}
