import {randomUUID} from 'node:crypto';
import {ConflictException, Inject, Injectable} from '@nestjs/common';
import {and, asc, eq, inArray, lte, or} from 'drizzle-orm';
import {z} from 'zod';
import {DatabaseService} from '../../../shared/infrastructure/database/database.service';
import {READ_SNAPSHOT, type DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {payments, paymentSettlements} from '../../../shared/infrastructure/database/schema';
import {paymentRefundJobs as jobs, paymentRefundScans as scans, paymentRefundScanItems as items, paymentRefundBalances as balances} from '../../../shared/infrastructure/database/schema.refund-payment-settlements';
import {findIdentityAccess, IdentityAccessMode} from '../../identity/infrastructure/persistence/identity-access';
import {REFUND_SETTLEMENT as C, refundSourceSchema, refundDocumentSchema, refundSnapshotSchema, refundSnapshotComplete,
  type RefundSource, type RefundReservation, type RefundReadResult, type RefundDocument} from '../domain/refund-settlement';
import type {RefundSettlementRepository} from '../domain/refund-settlement.repository';
import {requestRefundSettlement} from './refund-settlement-queue';
import {recordRefundSnapshot, storedRefundBalance, RefundBalanceConflict} from './refund-settlement-recording';

const releasing = {leaseToken: null, leaseUntil: null};
@Injectable()
export class DrizzleRefundSettlementsRepository implements RefundSettlementRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseSession) {}
  transaction<T>(write: boolean, operation: (repository: RefundSettlementRepository) => Promise<T>): Promise<T> {
    return this.database.db.transaction(tx => operation(new DrizzleRefundSettlementsRepository({db: tx})), write ? undefined : READ_SNAPSHOT);
  }
  access(actorId: string, write: boolean) { return findIdentityAccess(this.database, actorId, write ? IdentityAccessMode.Lock : IdentityAccessMode.Read); }
  async source(paymentId: string): Promise<RefundSource | undefined> {
    const [row] = await this.database.db.select({receipt: paymentSettlements, orderId: payments.orderId, paymentIntentId: payments.providerPaymentIntentId})
      .from(paymentSettlements).innerJoin(payments, eq(payments.id, paymentSettlements.paymentId)).where(eq(payments.id, paymentId));
    if (!row) return undefined;
    const {paymentId: receiptPayment, recordedAt, ...capture} = row.receipt;
    return project(refundSourceSchema, {paymentId, orderId: row.orderId, paymentIntentId: row.paymentIntentId,
      capture: {...capture, capturedAt: row.receipt.capturedAt.toISOString(), availableAt: row.receipt.availableAt.toISOString()}});
  }
  request(paymentId: string) { return requestRefundSettlement(this.database, paymentId); }
  async requestCharge(chargeId: string, liveMode: boolean): Promise<boolean> {
    return this.database.db.transaction(async tx => {
      const [row] = await tx.select({paymentId: paymentSettlements.paymentId}).from(paymentSettlements)
        .where(and(eq(paymentSettlements.chargeId, chargeId), eq(paymentSettlements.liveMode, liveMode)));
      if (!row) return false;
      await requestRefundSettlement({db: tx}, row.paymentId); return true;
    });
  }
  async document(paymentId: string): Promise<RefundDocument | undefined> {
    const asOf = new Date().toISOString(), source = await this.source(paymentId);
    if (!source) return undefined;
    const [job] = await this.database.db.select().from(jobs).where(eq(jobs.paymentId, paymentId));
    if (!job) throw new ConflictException(C.request.persisted);
    let snapshot = null;
    if (job.latestScanId !== null) {
      const [scan] = await this.database.db.select().from(scans).where(eq(scans.id, job.latestScanId));
      const rows = await this.database.db.select().from(items).where(eq(items.scanId, job.latestScanId)).orderBy(asc(items.refundId));
      if (!scan || scan.paymentId !== paymentId || scan.generation !== job.observedGeneration || scan.itemCount !== rows.length) throw new ConflictException(C.request.persisted);
      const ids = rows.flatMap(row => [row.debitId, row.failureId].flatMap(id => id === null ? [] : [id]));
      const entries = ids.length ? await this.database.db.select().from(balances).where(inArray(balances.id, ids)) : [];
      const recorded = new Map(entries.map(row => [row.id, storedRefundBalance(row)]));
      if (entries.length !== ids.length) throw new ConflictException(C.request.persisted);
      snapshot = {...project(refundSnapshotSchema, {source, observedAt: scan.observedAt.toISOString(), amountRefunded: scan.amountRefunded, disputed: scan.disputed,
        items: rows.map(row => ({refundId: row.refundId, amount: row.amount, currency: row.currency, status: row.status, createdAt: row.createdAt.toISOString(),
          debit: row.debitId === null ? null : recorded.get(row.debitId), failure: row.failureId === null ? null : recorded.get(row.failureId)}))}),
      id: scan.id, generation: scan.generation, recordedAt: scan.recordedAt.toISOString()};
    }
    return project(refundDocumentSchema, {source, state: job.status, asOf, generation: job.generation, observedGeneration: job.observedGeneration,
      failureCode: job.failureCode, nextAttemptAt: job.nextAttemptAt?.toISOString() ?? null, snapshot});
  }
  async claim(): Promise<RefundReservation[]> {
    return this.database.db.transaction(async tx => {
      const now = new Date(), repository = new DrizzleRefundSettlementsRepository({db: tx});
      const selected = await tx.select().from(jobs).where(or(and(eq(jobs.status, C.state.queued), lte(jobs.nextAttemptAt, now)),
        and(eq(jobs.status, C.state.processing), lte(jobs.leaseUntil, now))))
        .orderBy(asc(jobs.createdAt), asc(jobs.paymentId)).limit(C.limits.batch).for(C.lock, {skipLocked: true});
      const claims: RefundReservation[] = [];
      for (const row of selected) {
        let source;
        try { source = await repository.source(row.paymentId); }
        catch (error) { if (!(error instanceof ConflictException)) throw error; }
        if (!source) {
          await tx.update(jobs).set({...releasing, status: C.state.review, nextAttemptAt: null, failureCode: C.failure.changed, updatedAt: now}).where(eq(jobs.paymentId, row.paymentId));
          continue;
        }
        const leaseToken = randomUUID(), attempts = row.attempts + C.limits.one;
        await tx.update(jobs).set({status: C.state.processing, attempts, leaseToken, leaseUntil: new Date(now.getTime() + C.limits.leaseMs),
          failureCode: null, nextAttemptAt: null, updatedAt: now}).where(eq(jobs.paymentId, row.paymentId));
        claims.push({source, leaseToken, attempts, generation: row.generation});
      }
      return claims;
    });
  }
  async finish(claim: RefundReservation, result: RefundReadResult): Promise<boolean> {
    return this.database.db.transaction(async tx => {
      const now = new Date(), paymentId = claim.source.paymentId;
      const [job] = await tx.select().from(jobs).where(eq(jobs.paymentId, paymentId)).for(C.lock);
      if (!job || job.status !== C.state.processing || job.leaseToken !== claim.leaseToken || job.attempts !== claim.attempts
        || !job.leaseUntil || job.leaseUntil <= now) return false;
      const source = await new DrizzleRefundSettlementsRepository({db: tx}).source(paymentId);
      if (!source || JSON.stringify(source) !== JSON.stringify(claim.source)) result = {kind: C.result.review, reason: C.failure.changed};
      let scanId: string | undefined, complete = false;
      if (result.kind === C.result.observed) {
        const parsed = refundSnapshotSchema.safeParse(result.snapshot);
        if (!parsed.success || JSON.stringify(parsed.data.source) !== JSON.stringify(claim.source)) result = {kind: C.result.review, reason: C.failure.invalid};
        else {
          try { scanId = await tx.transaction(savepoint => recordRefundSnapshot({db: savepoint}, parsed.data, claim.generation)); complete = refundSnapshotComplete(parsed.data); }
          catch (error) { if (!(error instanceof RefundBalanceConflict)) throw error; result = {kind: C.result.review, reason: C.failure.linked}; }
        }
      }
      const newer = job.generation > claim.generation;
      const retry = newer || result.kind === C.result.retry || result.kind === C.result.observed && !complete;
      const delay = newer ? C.limits.zero : Math.min(C.limits.maximumRetryMs, C.limits.firstRetryMs * C.limits.retryFactor ** (claim.attempts - C.limits.one));
      await tx.update(jobs).set({...releasing, status: retry ? C.state.queued : result.kind === C.result.observed ? C.state.synced : C.state.review,
        failureCode: newer ? null : result.kind === C.result.observed ? complete ? null : C.failure.pending : result.reason,
        nextAttemptAt: retry ? new Date(now.getTime() + delay) : null, updatedAt: now,
        ...(scanId ? {latestScanId: scanId, observedGeneration: claim.generation} : {}), ...(newer ? {attempts: C.limits.zero} : {}),
      }).where(eq(jobs.paymentId, paymentId));
      return true;
    });
  }
}
function project<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ConflictException(C.request.persisted);
  return parsed.data;
}
