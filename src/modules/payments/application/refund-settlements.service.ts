import {BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException} from '@nestjs/common';
import {getEnv} from '../../../config/env';
import {isUserAdministrator} from '../../identity/domain/user-administration.policy';
import {CONNECT} from '../domain/connect-account';
import {paymentSettlementIDSchema, paymentSettlementSyncSchema, captureReceiptSchema} from '../domain/payment-settlement';
import {REFUND_SETTLEMENT as C} from '../domain/refund-settlement';
import type {RefundSettlementRepository} from '../domain/refund-settlement.repository';
import {STRIPE_CLIENT, STRIPE_COMMERCE} from './stripe-commerce';
import {readStripeRefundSettlement, type RefundSettlementClient} from '../infrastructure/stripe-refund-settlement';

@Injectable()
export class RefundSettlementsService {
  private readonly mode = selectedMode();
  constructor(@Inject(C.repository) private readonly repository: RefundSettlementRepository,
    @Inject(STRIPE_CLIENT) private readonly stripe: RefundSettlementClient | null) {}
  get canSynchronize(): boolean { return this.stripe !== null && this.mode !== undefined; }
  document(actorId: string, id: string) { return this.authorized(actorId, id, false); }
  synchronize(actorId: string, id: string, raw: unknown) {
    if (!paymentSettlementSyncSchema.safeParse(raw).success) throw new BadRequestException(C.request.invalid);
    return this.authorized(actorId, id, true);
  }
  private async authorized(actorId: string, id: string, write: boolean) {
    const parsed = paymentSettlementIDSchema.safeParse(id);
    if (!parsed.success) throw new BadRequestException(C.request.invalid);
    return this.repository.transaction(write, async repository => {
      if (!isUserAdministrator(await repository.access(actorId, write))) throw new ForbiddenException(C.request.access);
      const document = await repository.document(parsed.data);
      if (!document) throw new NotFoundException(C.request.missing);
      if (!write) return document;
      if (!this.canSynchronize) throw new ServiceUnavailableException(STRIPE_COMMERCE.configuration.paymentsUnavailable);
      await repository.request(parsed.data);
      const queued = await repository.document(parsed.data);
      if (!queued) throw new NotFoundException(C.request.missing);
      return queued;
    });
  }
  async requestCharge(chargeId: string, liveMode: boolean): Promise<boolean> {
    if (this.mode === undefined || liveMode !== this.mode || !captureReceiptSchema.shape.chargeId.safeParse(chargeId).success) return false;
    return this.repository.requestCharge(chargeId, liveMode);
  }
  async recoverDue(): Promise<void> {
    const stripe = this.stripe, mode = this.mode;
    if (!stripe || mode === undefined) return;
    const claims = await this.repository.claim();
    await Promise.allSettled(claims.map(async claim => {
      const result = await readStripeRefundSettlement(stripe, claim.source, mode);
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
