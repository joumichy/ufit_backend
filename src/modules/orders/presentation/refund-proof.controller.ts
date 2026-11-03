import {BadRequestException,Body,Controller,Get,Inject,Param,Post,Query,Res,UploadedFile,UseGuards,UseInterceptors} from '@nestjs/common';
import {z} from 'zod';
import {FileInterceptor} from '@nestjs/platform-express';
import type {Response} from 'express';
import {AuthGuard} from '../../../shared/presentation/guards/auth.guard';
import {RoleGuard} from '../../../shared/presentation/guards/role.guard';
import {Roles} from '../../../shared/presentation/decorators/roles.decorator';
import {CurrentUser} from '../../../shared/presentation/decorators/current-user.decorator';
import type {AuthenticatedUser} from '../../identity/domain/user.types';
import {REFUND_RECOVERY as R} from '../domain/refund-recovery.contract';
import {REFUND_ORGANIZATION as O,refundOrganizationScopeSchema} from '../domain/refund-organization';
import {REFUND_PROOF as P,refundProofHistoryQuerySchema,type RefundProofFile} from '../domain/refund-proof.contract';
import {RefundProofService} from '../application/refund-proof.service';

@Controller(O.route.private) @UseGuards(AuthGuard)
export class PrivateRefundProofController {
  constructor(@Inject(RefundProofService) private readonly proofs:RefundProofService) {}
  @Post(P.route.upload)
  @UseInterceptors(FileInterceptor(P.multipart.file,{limits:{fileSize:P.file.maximumBytes,files:P.multipart.files,fields:P.multipart.fields}}))
  upload(@CurrentUser() user:AuthenticatedUser,@Param(R.route.kind) kind:string,@Param(R.route.id) id:string,@Body() body:unknown,@UploadedFile() file?:RefundProofFile) {
    return this.proofs.upload({scope:O.scope.brand,actorId:user.id},kind,id,body,file);
  }
  @Get(P.route.upload)
  history(@CurrentUser() user:AuthenticatedUser,@Param(R.route.kind) kind:string,@Param(R.route.id) id:string,@Query() raw:unknown) {
    const parsed=privateHistoryQuery.safeParse(raw);
    if(!parsed.success)throw new BadRequestException(P.failure.input);
    const {scope,...query}=parsed.data;
    return this.proofs.history({scope,actorId:user.id},kind,id,query);
  }
  @Get(P.route.receipt)
  receipt(@CurrentUser() user:AuthenticatedUser,@Param(R.route.kind) kind:string,@Param(R.route.id) id:string,@Param(O.route.requestId) requestId:string) {
    return this.proofs.receipt({scope:O.scope.brand,actorId:user.id},kind,id,requestId);
  }
  @Get(P.route.file)
  async file(@CurrentUser() user:AuthenticatedUser,@Param(R.route.kind) kind:string,@Param(R.route.id) id:string,@Param(P.route.proofId) proofId:string,@Query() raw:unknown,@Res() response:Response) {
    const scope=refundOrganizationScopeSchema.safeParse(raw);
    if(!scope.success)throw new BadRequestException(O.failure.input);
    const file=await this.proofs.file({scope:scope.data.scope,actorId:user.id},kind,id,proofId);
    response.setHeader(P.download.cacheHeader,P.download.cacheValue);response.setHeader(P.download.typeHeader,file.contentType);response.setHeader(P.download.sizeHeader,file.bytes.length);response.send(file.bytes);
  }
}
@Controller(O.route.admin) @UseGuards(AuthGuard,RoleGuard) @Roles(...R.roles)
export class AdminRefundProofController {
  @Get(P.route.upload)
  history(@CurrentUser() user:AuthenticatedUser,@Param(R.route.kind) kind:string,@Param(R.route.id) id:string,@Query() raw:unknown) {
    return this.proofs.history({scope:O.scope.administrator,actorId:user.id},kind,id,raw);
  }

  constructor(@Inject(RefundProofService) private readonly proofs:RefundProofService) {}
  @Get(P.route.file)
  async file(@CurrentUser() user:AuthenticatedUser,@Param(R.route.kind) kind:string,@Param(R.route.id) id:string,@Param(P.route.proofId) proofId:string,@Res() response:Response) {
    const file=await this.proofs.file({scope:O.scope.administrator,actorId:user.id},kind,id,proofId);
    response.setHeader(P.download.cacheHeader,P.download.cacheValue);response.setHeader(P.download.typeHeader,file.contentType);response.setHeader(P.download.sizeHeader,file.bytes.length);response.send(file.bytes);
  }
}

const privateHistoryQuery=z.object({...refundProofHistoryQuerySchema.shape,scope:refundOrganizationScopeSchema.shape.scope}).strict();
