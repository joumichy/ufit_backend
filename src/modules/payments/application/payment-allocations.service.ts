import {BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException} from '@nestjs/common';
import {isUserAdministrator} from '../../identity/domain/user-administration.policy';
import {PAYMENT_ALLOCATION as C, allocationIDSchema, allocationPrepareSchema} from '../domain/payment-allocation';
import type {PaymentAllocationRepository} from '../domain/payment-allocation.repository';

@Injectable()
export class PaymentAllocationsService {
  constructor(@Inject(C.repository) private readonly repository: PaymentAllocationRepository) {}
  document(actorId: string, paymentId: string) { return this.authorized(actorId, paymentId, false); }
  prepare(actorId: string, paymentId: string, raw: unknown) {
    if (!allocationPrepareSchema.safeParse(raw).success) throw new BadRequestException(C.failure.input);
    return this.authorized(actorId, paymentId, true);
  }
  private authorized(actorId: string, raw: string, write: boolean) {
    const id = allocationIDSchema.safeParse(raw);
    if (!id.success) throw new BadRequestException(C.failure.input);
    return this.repository.transaction(write, async repository => {
      if (!isUserAdministrator(await repository.access(actorId, write))) throw new ForbiddenException(C.failure.access);
      if (write && !await repository.prepare(id.data)) throw new NotFoundException(C.failure.missing);
      const document = await repository.document(id.data);
      if (!document) throw new NotFoundException(C.failure.missing);
      return document;
    });
  }
}
