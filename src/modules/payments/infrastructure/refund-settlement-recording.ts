import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import type {DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {paymentRefundScans as scans, paymentRefundScanItems as items, paymentRefundBalances as balances} from '../../../shared/infrastructure/database/schema.refund-payment-settlements';
import {refundBalanceSchema, type RefundSnapshot, type RefundBalance} from '../domain/refund-settlement';

export class RefundBalanceConflict extends Error {}
export function storedRefundBalance(row: typeof balances.$inferSelect): RefundBalance {
  const {paymentId, recordedAt, ...value} = row;
  return refundBalanceSchema.parse({...value, createdAt: row.createdAt.toISOString(), availableAt: row.availableAt.toISOString()});
}
/** A savepoint owned by finish() rolls back every new row if an immutable movement conflicts. */
export async function recordRefundSnapshot(database: DatabaseSession, snapshot: RefundSnapshot, generation: number): Promise<string> {
  const scanId = randomUUID(), paymentId = snapshot.source.paymentId;
  for (const item of snapshot.items) {
    for (const balance of [item.debit, item.failure]) {
      if (balance === null) continue;
      const [inserted] = await database.db.insert(balances).values({...balance, paymentId,
        createdAt: new Date(balance.createdAt), availableAt: new Date(balance.availableAt)}).onConflictDoNothing().returning({id: balances.id});
      if (inserted) continue;
      const [previous] = await database.db.select().from(balances).where(eq(balances.id, balance.id));
      if (!previous || previous.paymentId !== paymentId || JSON.stringify(storedRefundBalance(previous)) !== JSON.stringify(balance)) throw new RefundBalanceConflict();
    }
  }
  await database.db.insert(scans).values({id: scanId, paymentId, generation, observedAt: new Date(snapshot.observedAt), amountRefunded: snapshot.amountRefunded,
    disputed: snapshot.disputed, itemCount: snapshot.items.length});
  if (snapshot.items.length) await database.db.insert(items).values(snapshot.items.map(item => ({scanId, paymentId, refundId: item.refundId,
    amount: item.amount, currency: item.currency, status: item.status, createdAt: new Date(item.createdAt),
    debitId: item.debit?.id ?? null, failureId: item.failure?.id ?? null})));
  return scanId;
}
