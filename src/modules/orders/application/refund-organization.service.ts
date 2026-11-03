import {BadRequestException, Inject, Injectable, NotFoundException} from '@nestjs/common';
import {z} from 'zod';
import {REFUND_ORGANIZATION as O, refundOrganizationCommandSchema, refundOrganizationReferenceSchema,
  type RefundOrganizationAccess, type RefundOrganizationRepository} from '../domain/refund-organization';

@Injectable()
export class RefundOrganizationService {
  constructor(@Inject(O.repository) private readonly organizations: RefundOrganizationRepository) {}
  private reference(kind: string, id: string) {
    const parsed=refundOrganizationReferenceSchema.safeParse({kind,id});
    if(!parsed.success) throw new BadRequestException(O.failure.input);
    return parsed.data;
  }
  read(access: RefundOrganizationAccess, kind: string, id: string) {return this.organizations.read(access,this.reference(kind,id));}
  apply(access: RefundOrganizationAccess, kind: string, id: string, raw: unknown) {
    const command=refundOrganizationCommandSchema.safeParse(raw);
    if(!command.success) throw new BadRequestException(O.failure.input);
    return this.organizations.apply(access,this.reference(kind,id),command.data);
  }
  async receipt(access: RefundOrganizationAccess, kind: string, id: string, rawRequestId: string) {
    const requestId=z.uuid().safeParse(rawRequestId);
    if(!requestId.success) throw new BadRequestException(O.failure.input);
    const result=await this.organizations.receipt(access,this.reference(kind,id),requestId.data);
    if(!result) throw new NotFoundException(O.failure.receipt);
    return result;
  }
}
