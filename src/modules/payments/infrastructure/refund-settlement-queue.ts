import {sql} from 'drizzle-orm';
import type {DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {paymentRefundJobs as jobs} from '../../../shared/infrastructure/database/schema.refund-payment-settlements';
import {REFUND_SETTLEMENT as C} from '../domain/refund-settlement';

export async function requestRefundSettlement(database: DatabaseSession, paymentId: string): Promise<void> {
  const now = new Date();
  await database.db.insert(jobs).values({paymentId, status: C.state.queued, generation: C.limits.one,
    observedGeneration: C.limits.zero, nextAttemptAt: now}).onConflictDoUpdate({target: jobs.paymentId, set: {
    generation: sql`${jobs.generation}+${C.limits.one}`, updatedAt: now,
    status: sql`case when ${jobs.status}=${C.state.processing} then ${C.state.processing} else ${C.state.queued} end`,
    nextAttemptAt: sql`case when ${jobs.status}=${C.state.processing} then null else ${now}::timestamptz end`,
    attempts: sql`case when ${jobs.status}=${C.state.processing} then ${jobs.attempts} else ${C.limits.zero} end`,
    failureCode: null,
  }});
}
