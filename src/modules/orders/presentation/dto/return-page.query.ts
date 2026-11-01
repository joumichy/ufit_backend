import {IsIn, IsOptional} from 'class-validator';
import {OrderPageQuery} from './order-page.query';
import {RETURN_STATUS, type ReturnStatus} from '../../domain/order-return.contract';

export class ReturnPageQuery extends OrderPageQuery {
  @IsOptional() @IsIn(Object.values(RETURN_STATUS)) status?: ReturnStatus;
}
