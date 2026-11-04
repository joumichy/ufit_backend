import {createHash} from 'node:crypto';
import {BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException} from '@nestjs/common';
import {isUserAdministrator} from '../../identity/domain/user-administration.policy';
import {PAYMENT_DISTRIBUTION as C, distributionIDSchema, distributionChangeSchema, distributionBrandQuerySchema,
  distributionPageSchema, distributionResultSchema, platformCommissionAmount, DistributionBudgetExceeded, type DistributionResult} from '../domain/payment-distribution';
import {PROFILE_STATUS} from '../../../shared/domain/profile-editing.contract';
import type {PaymentDistributionRepository} from '../domain/payment-distribution.repository';

@Injectable()
export class PaymentDistributionService {
  constructor(@Inject(C.repository) private readonly repository: PaymentDistributionRepository) {}
  brands(actorId: string, raw: unknown) {
    const query = distributionBrandQuerySchema.safeParse(raw);
    if (!query.success) throw new BadRequestException(C.failure.input);
    return this.authorized(actorId, false, repository => repository.brands(query.data));
  }
  document(actorId: string, brandId: string) {
    const id = identifier(brandId);
    return this.authorized(actorId, false, async repository => {
      const document = await repository.document(id, false);
      if (!document) throw new NotFoundException(C.failure.missing);
      return document;
    });
  }
  history(actorId: string, brandId: string, raw: unknown) {
    const id = identifier(brandId), query = distributionPageSchema.safeParse(raw);
    if (!query.success) throw new BadRequestException(C.failure.input);
    return this.authorized(actorId, false, async repository => {
      if (!await repository.document(id, false)) throw new NotFoundException(C.failure.missing);
      return repository.history(id, query.data);
    });
  }
  change(actorId: string, brandId: string, requestId: string): Promise<DistributionResult> {
    const id = identifier(brandId), request = identifier(requestId);
    return this.authorized(actorId, false, async repository => {
      const receipt = await repository.change(request), document = await repository.document(id, false);
      if (!document) throw new NotFoundException(C.failure.missing);
      if (!receipt || receipt.actorId !== actorId || receipt.revision.brandId !== id) throw new NotFoundException(C.failure.receipt);
      return distributionResultSchema.parse({receipt: receipt.revision, document});
    });
  }
  revise(actorId: string, brandId: string, raw: unknown): Promise<DistributionResult> {
    const id = identifier(brandId), parsed = distributionChangeSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(C.failure.input);
    const input = parsed.data;
    const requestHash = createHash(C.request.hashAlgorithm).update(JSON.stringify({actorId, brandId: id, input})).digest(C.request.hashEncoding);
    return this.authorized(actorId, true, async repository => {
      const document = await repository.document(id, true);
      if (!document) throw new NotFoundException(C.failure.missing);
      const previous = await repository.change(input.requestId);
      if (previous) {
        if (previous.actorId !== actorId || previous.revision.brandId !== id || previous.requestHash !== requestHash) throw new ConflictException(C.failure.reused);
        return distributionResultSchema.parse({receipt: previous.revision, document});
      }
      if ((document.current?.revision ?? C.limits.zero) !== input.expectedRevision) throw new ConflictException(C.failure.changed);
      const receipt = await repository.revise(id, actorId, requestHash, input, document.current);
      const current = await repository.document(id, false);
      if (!current) throw new NotFoundException(C.failure.missing);
      return distributionResultSchema.parse({receipt, document: current});
    });
  }
  assertOrderTerms(orderId: string): Promise<void> {
    const id = identifier(orderId);
    return this.repository.transaction(false, repository => repository.assertOrderTerms(id));
  }
  async assertSaleTerms(brandId: string, subtotal: number, creatorCommission: number): Promise<void> {
    const id = identifier(brandId);
    await this.repository.transaction(false, async repository => {
      const document = await repository.document(id, false);
      if (document?.brand.status !== PROFILE_STATUS.active || !document.current?.active) throw new ConflictException(C.failure.unavailable);
      try { platformCommissionAmount(subtotal, creatorCommission, document.current.platformRateBps); }
      catch (error) {
        if (error instanceof DistributionBudgetExceeded) throw new ConflictException(C.failure.budget);
        throw new ConflictException(C.failure.persisted);
      }
    });
  }
  private authorized<T>(actorId: string, write: boolean, operation: (repository: PaymentDistributionRepository) => Promise<T>) {
    return this.repository.transaction(write, async repository => {
      if (!isUserAdministrator(await repository.access(actorId, write))) throw new ForbiddenException(C.failure.access);
      return operation(repository);
    });
  }
}
function identifier(raw: string): string {
  const parsed = distributionIDSchema.safeParse(raw);
  if (!parsed.success) throw new BadRequestException(C.failure.input);
  return parsed.data;
}
