import {BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException} from '@nestjs/common';
import {getEnv} from '../../../config/env';
import {isUserAdministrator} from '../../identity/domain/user-administration.policy';
import {CONNECT} from '../domain/connect-account';
import {PAYMENT_SETTLEMENT as C, paymentSettlementIDSchema, paymentSettlementSyncSchema} from '../domain/payment-settlement';
import type {PaymentSettlementRepository} from '../domain/payment-settlement.repository';
import {STRIPE_CLIENT, STRIPE_COMMERCE} from './stripe-commerce';
import type {StripePaymentsClient} from './payments.service';
import {readStripePaymentSettlement} from '../infrastructure/stripe-payment-settlement';

@Injectable()
export class PaymentSettlementsService {
  private readonly mode = selectedMode();
  constructor(@Inject(C.repository) private readonly repository: PaymentSettlementRepository,
    @Inject(STRIPE_CLIENT) private readonly stripe: StripePaymentsClient | null) {}
  get canSynchronize(): boolean { return this.stripe !== null && this.mode !== undefined; }
  document(actorId: string, id: string) { return this.authorized(actorId, id, false); }
  synchronize(actorId: string, id: string, raw: unknown) {
    if (!paymentSettlementSyncSchema.safeParse(raw).success) throw new BadRequestException(C.requestFailure.invalid);
    return this.authorized(actorId, id, true);
  }
  private async authorized(actorId: string, id: string, write: boolean) {
    const parsed = paymentSettlementIDSchema.safeParse(id);
    if (!parsed.success) throw new BadRequestException(C.requestFailure.invalid);
    return this.repository.transaction(write, async repository => {
      if (!isUserAdministrator(await repository.access(actorId, write))) throw new ForbiddenException(C.requestFailure.access);
      const document = await repository.document(parsed.data);
      if (!document) throw new NotFoundException(C.requestFailure.missing);
      if (!write) return document;
      if (!this.canSynchronize) throw new ServiceUnavailableException(STRIPE_COMMERCE.configuration.paymentsUnavailable);
      await repository.enqueue(parsed.data);
      const queued = await repository.document(parsed.data);
      if (!queued) throw new NotFoundException(C.requestFailure.missing);
      return queued;
    });
  }
  async recoverDue(): Promise<void> {
    const stripe = this.stripe, mode = this.mode;
    if (!stripe || mode === undefined) return;
    const claims = await this.repository.claim();
    await Promise.allSettled(claims.map(async claim => {
      const result = await readStripePaymentSettlement(stripe, claim.payment, mode);
      await this.repository.finish(claim, result);
    }));
  }
}
function selectedMode(): boolean | undefined {
  const key = getEnv().STRIPE_SECRET_KEY;
  if (key && CONNECT.key.test.some(prefix => key.startsWith(prefix))) return false;
  if (key && CONNECT.key.live.some(prefix => key.startsWith(prefix))) return true;
  return undefined;
}
