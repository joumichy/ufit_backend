import {randomUUID} from 'node:crypto';
import {ConflictException, Inject, Injectable} from '@nestjs/common';
import {and, asc, eq, lte, or} from 'drizzle-orm';
import {DatabaseService} from '../../../shared/infrastructure/database/database.service';
import {READ_SNAPSHOT, type DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {orders, payments, paymentSettlementJobs as jobs, paymentSettlements as receipts} from '../../../shared/infrastructure/database/schema';
import {findIdentityAccess, IdentityAccessMode} from '../../identity/infrastructure/persistence/identity-access';
import {ORDER_PAYMENT} from '../../orders/domain/order-lifecycle';
import {PAYMENT_SETTLEMENT as C, captureReceiptSchema, paymentSettlementDocumentSchema, settlementPaymentSchema,
  type CaptureReadResult, type CaptureReservation, type CaptureReceipt, type SettlementPayment} from '../domain/payment-settlement';
import type {PaymentSettlementRepository} from '../domain/payment-settlement.repository';
import {enqueuePaymentSettlement} from './stripe-capture-recording';

const releasing = {leaseToken: null, leaseUntil: null};
@Injectable()
export class DrizzlePaymentSettlementsRepository implements PaymentSettlementRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseSession) {}
  transaction<T>(write: boolean, operation: (repository: PaymentSettlementRepository) => Promise<T>): Promise<T> {
    return this.database.db.transaction(tx => operation(new DrizzlePaymentSettlementsRepository({db: tx})), write ? undefined : READ_SNAPSHOT);
  }
  access(actorId: string, write: boolean) { return findIdentityAccess(this.database, actorId, write ? IdentityAccessMode.Lock : IdentityAccessMode.Read); }
  private async payment(id: string): Promise<SettlementPayment | undefined> {
    const [row] = await this.database.db.select({id: payments.id, orderId: payments.orderId, orderNumber: orders.orderNumber,
      provider: payments.provider, status: payments.status, amount: payments.amount, currency: payments.currency,
      providerPaymentIntentId: payments.providerPaymentIntentId, createdAt: payments.createdAt})
      .from(payments).innerJoin(orders, eq(orders.id, payments.orderId)).where(eq(payments.id, id));
    if (!row) return undefined;
    if (row.provider !== ORDER_PAYMENT.provider || row.providerPaymentIntentId === null) throw new ConflictException(C.requestFailure.unsupported);
    const {provider, ...payment} = row;
    const parsed = settlementPaymentSchema.safeParse({...payment, createdAt: row.createdAt.toISOString()});
    if (!parsed.success) throw new ConflictException(C.requestFailure.persisted);
    return parsed.data;
  }
  private async synchronizablePayment(id: string): Promise<SettlementPayment | undefined> {
    try { return await this.payment(id); }
    catch (error) { if (error instanceof ConflictException) return undefined; throw error; }
  }
  async document(paymentId: string) {
    const asOf = new Date().toISOString();
    const payment = await this.payment(paymentId);
    if (!payment) return undefined;
    const [job] = await this.database.db.select().from(jobs).where(eq(jobs.paymentId, paymentId));
    const [receipt] = await this.database.db.select().from(receipts).where(eq(receipts.paymentId, paymentId));
    const parsed = paymentSettlementDocumentSchema.safeParse({payment, state: job ? job.status : C.state.notRequested, asOf,
      receipt: receipt ? {...receiptSource(receipt), recordedAt: receipt.recordedAt.toISOString()} : null,
      failureCode: job ? job.failureCode : null, nextAttemptAt: job?.nextAttemptAt ? job.nextAttemptAt.toISOString() : null});
    if (!parsed.success) throw new ConflictException(C.requestFailure.persisted);
    return parsed.data;
  }
  async enqueue(paymentId: string) {
    await enqueuePaymentSettlement(this.database, paymentId);
    const [job] = await this.database.db.select().from(jobs).where(eq(jobs.paymentId, paymentId)).for(C.lock);
    if (job.status === C.state.recorded || job.status === C.state.processing) return;
    const now = new Date();
    await this.database.db.update(jobs).set({...releasing, status: C.state.queued, failureCode: null, nextAttemptAt: now, updatedAt: now})
      .where(eq(jobs.paymentId, paymentId));
  }
  async claim(): Promise<CaptureReservation[]> {
    return this.database.db.transaction(async tx => {
      const now = new Date(), repository = new DrizzlePaymentSettlementsRepository({db: tx});
      const selected = await tx.select().from(jobs).where(or(
        and(eq(jobs.status, C.state.queued), lte(jobs.nextAttemptAt, now)),
        and(eq(jobs.status, C.state.processing), lte(jobs.leaseUntil, now))))
        .orderBy(asc(jobs.createdAt), asc(jobs.paymentId)).limit(C.limits.batch).for(C.lock, {skipLocked: true});
      const claims: CaptureReservation[] = [];
      for (const row of selected) {
        const payment = await repository.synchronizablePayment(row.paymentId);
        if (!payment) {
          await tx.update(jobs).set({...releasing, status: C.state.needsReview, nextAttemptAt: null, failureCode: C.failure.changed, updatedAt: now})
            .where(eq(jobs.paymentId, row.paymentId));
          continue;
        }
        const leaseToken = randomUUID(), attempts = row.attempts + C.limits.one;
        await tx.update(jobs).set({status: C.state.processing, attempts, leaseToken, leaseUntil: new Date(now.getTime() + C.limits.leaseMs),
          nextAttemptAt: null, failureCode: null, updatedAt: now}).where(eq(jobs.paymentId, row.paymentId));
        claims.push({payment, leaseToken, attempts});
      }
      return claims;
    });
  }
  async finish(claim: CaptureReservation, result: CaptureReadResult): Promise<boolean> {
    return this.database.db.transaction(async tx => {
      const now = new Date();
      const [job] = await tx.select().from(jobs).where(eq(jobs.paymentId, claim.payment.id)).for(C.lock);
      if (!job || job.status !== C.state.processing || job.leaseToken !== claim.leaseToken || job.attempts !== claim.attempts
        || !job.leaseUntil || job.leaseUntil <= now) return false;
      const repository = new DrizzlePaymentSettlementsRepository({db: tx});
      const payment = await repository.synchronizablePayment(claim.payment.id);
      if (!payment || payment.providerPaymentIntentId !== claim.payment.providerPaymentIntentId
        || payment.amount !== claim.payment.amount || payment.currency !== claim.payment.currency) result = {kind: C.result.review, reason: C.failure.changed};
      if (result.kind === C.result.receipt) {
        const receipt = captureReceiptSchema.parse(result.receipt);
        if (receipt.chargeAmount !== claim.payment.amount || receipt.chargeCurrency !== claim.payment.currency) result = {kind: C.result.review, reason: C.failure.mismatch};
        else {
          const [inserted] = await tx.insert(receipts).values({paymentId: claim.payment.id, ...receipt,
            capturedAt: new Date(receipt.capturedAt), availableAt: new Date(receipt.availableAt)})
            .onConflictDoNothing().returning({id: receipts.paymentId});
          if (!inserted) {
            const [existing] = await tx.select().from(receipts).where(eq(receipts.paymentId, claim.payment.id));
            if (!existing || JSON.stringify(receiptSource(existing)) !== JSON.stringify(receipt)) result = {kind: C.result.review, reason: C.failure.linked};
          }
        }
      }
      if (result.kind === C.result.receipt) {
        await tx.update(jobs).set({...releasing, status: C.state.recorded, nextAttemptAt: null, failureCode: null, updatedAt: now})
          .where(eq(jobs.paymentId, claim.payment.id));
      } else {
        const retry = result.kind === C.result.retry;
        const delay = Math.min(C.limits.maximumRetryMs, C.limits.firstRetryMs * C.limits.retryFactor ** (claim.attempts - C.limits.one));
        await tx.update(jobs).set({...releasing, status: retry ? C.state.queued : C.state.needsReview, failureCode: result.reason,
          nextAttemptAt: retry ? new Date(now.getTime() + delay) : null, updatedAt: now}).where(eq(jobs.paymentId, claim.payment.id));
      }
      return true;
    });
  }
}
function receiptSource(row: typeof receipts.$inferSelect): CaptureReceipt {
  const {paymentId, recordedAt, ...source} = row;
  return captureReceiptSchema.parse({...source, capturedAt: row.capturedAt.toISOString(), availableAt: row.availableAt.toISOString()});
}
