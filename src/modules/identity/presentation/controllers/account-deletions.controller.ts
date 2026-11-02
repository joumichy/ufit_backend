import {Body,Controller,Get,Headers,HttpCode,Inject,Param,Put,Res} from '@nestjs/common';
import type {Response} from 'express';
import {ACCOUNT_DELETION as D} from '../../domain/account-deletion.contract';
import {AccountDeletionService} from '../../application/account-deletion.service';

@Controller(D.route.root)
export class AccountDeletionsController {
  constructor(@Inject(AccountDeletionService) private readonly service:AccountDeletionService) {}
  @Get(D.route.id)
  read(@Param(D.route.parameter) id:string,@Headers(D.route.proofHeader) proof:unknown,@Res({passthrough:true}) response:Response) {
    response.setHeader(D.http.cacheHeader,D.http.cacheValue);return this.service.read(id,proof);
  }
  @Put(D.route.id)
  @HttpCode(D.http.accepted)
  accept(@Param(D.route.parameter) id:string,@Headers(D.route.proofHeader) proof:unknown,
    @Headers(D.http.authorizationHeader) authorization:unknown,@Body() body:unknown,@Res({passthrough:true}) response:Response) {
    response.setHeader(D.http.cacheHeader,D.http.cacheValue);return this.service.accept(id,proof,authorization,body);
  }
}
