import {Body,Controller,Get,Inject,Param,Post,UseGuards} from '@nestjs/common';
import {CurrentUser} from '../../../shared/presentation/decorators/current-user.decorator';
import {Roles} from '../../../shared/presentation/decorators/roles.decorator';
import {AuthGuard} from '../../../shared/presentation/guards/auth.guard';
import {RoleGuard} from '../../../shared/presentation/guards/role.guard';
import type {AuthenticatedUser} from '../../identity/domain/user.types';
import {REFUND_ORGANIZATION as O} from '../domain/refund-organization';
import {REFUND_RECOVERY as Recovery} from '../domain/refund-recovery.contract';
import {REFUND_PROOF_REVIEW as R} from '../domain/refund-proof-review';
import {RefundProofReviewService} from '../application/refund-proof-review.service';

@Controller(O.route.admin) @UseGuards(AuthGuard,RoleGuard) @Roles(...Recovery.roles)
export class RefundProofReviewController {
  constructor(@Inject(RefundProofReviewService) private readonly reviews:RefundProofReviewService) {}
  @Post(R.route.review)
  review(@CurrentUser() user:AuthenticatedUser,@Param(Recovery.route.kind) kind:string,@Param(Recovery.route.id) id:string,@Body() body:unknown) {
    return this.reviews.review({scope:O.scope.administrator,actorId:user.id},kind,id,body);
  }
  @Get(R.route.receipt)
  receipt(@CurrentUser() user:AuthenticatedUser,@Param(Recovery.route.kind) kind:string,@Param(Recovery.route.id) id:string,@Param(O.route.requestId) requestId:string) {
    return this.reviews.receipt({scope:O.scope.administrator,actorId:user.id},kind,id,requestId);
  }
}
