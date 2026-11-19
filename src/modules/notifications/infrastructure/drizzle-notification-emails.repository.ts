import {notificationPreferences} from '../../../shared/infrastructure/database/schema.notification-preferences';
import {NOTIFICATION_PREFERENCES} from '../domain/notification-preferences';
import {Inject, Injectable, ConflictException, InternalServerErrorException, NotFoundException} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import {and, asc, eq, gte, inArray, isNull, lte, or} from 'drizzle-orm';
import {z} from 'zod';
import {alias} from 'drizzle-orm/pg-core';
import {DatabaseService} from '../../../shared/infrastructure/database/database.service';
import type {DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {users} from '../../../shared/infrastructure/database/schema.identity';
import {notificationEmailDeliveries as deliveries,notifications} from '../../../shared/infrastructure/database/schema.notifications';
import {NOTIFICATION,notificationIdentifierSchema} from '../domain/notification.contract';
import {EMAIL_DELIVERY, EMAIL_PROVIDER, emailProviderSchema, emailProviderReceiptSchema, transactionalEmailSchema,
  type EmailProvider, type TransactionalEmail, type EmailTransportResult} from '../domain/email-delivery';
import {NOTIFICATION_EMAIL, notificationSenderSchema, type NotificationSender} from '../domain/notification-email.contract';
import {notificationDeliveryScopeSchema, type NotificationDeliveryScope} from '../domain/notification-delivery-scope';

const claimable = alias(deliveries, NOTIFICATION_EMAIL.claimAlias);

export interface ClaimedNotificationEmail {id: string; leaseToken: string; attempts: number; provider: EmailProvider; email: TransactionalEmail;}

@Injectable()
export class DrizzleNotificationEmailsRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseSession) {}

  // A producer binds this repository to its existing business transaction.
  async enqueue(notificationId:string):Promise<string|null> {
    const id=notificationIdentifierSchema.parse(notificationId);
    const [source]=await this.database.db.select({message:notifications,email:users.email,status:users.status}).from(notifications)
      .innerJoin(users,eq(users.id,notifications.recipientUserId)).where(eq(notifications.id,id)).limit(EMAIL_DELIVERY.limits.minimum);
    if(!source)throw new NotFoundException(NOTIFICATION_EMAIL.failure.missing);
    if(source.status===NOTIFICATION_EMAIL.account.deleted)return null;
    if(!z.email().safeParse(source.email).success)throw invalid();
    const [preference]=await this.database.db.select({emailEnabled:notificationPreferences.emailEnabled}).from(notificationPreferences)
      .where(eq(notificationPreferences.userId,source.message.recipientUserId)).limit(EMAIL_DELIVERY.limits.minimum);
    const disabled=preference?.emailEnabled===false;
    const text=source.message.bodyText+NOTIFICATION.link.paragraph+NOTIFICATION.link.prefix+id;
    const [created]=await this.database.db.insert(deliveries).values({notificationId:id,recipientAddress:source.email,
      subject:source.message.subject,bodyText:text,status:disabled?NOTIFICATION_EMAIL.status.cancelled:NOTIFICATION_EMAIL.status.pending,
      lastFailure:disabled?NOTIFICATION_PREFERENCES.failure.disabled:null}).onConflictDoNothing({target:deliveries.notificationId}).returning({id:deliveries.id});
    if(created)return created.id;
    const [current]=await this.database.db.select().from(deliveries).where(eq(deliveries.notificationId,id)).limit(EMAIL_DELIVERY.limits.minimum);
    if(!current)throw invalid();
    if(current.subject!==source.message.subject||current.bodyText!==text)throw new ConflictException(NOTIFICATION_EMAIL.failure.changed);
    return current.id;
  }

  async claim(sender: NotificationSender, now = new Date(), scope?: NotificationDeliveryScope,
    provider: EmailProvider = EMAIL_PROVIDER.resend): Promise<ClaimedNotificationEmail[]> {
    const configured = notificationSenderSchema.parse(sender);
    const configuredProvider = emailProviderSchema.parse(provider);
    const selectedScope = scope === undefined ? undefined : notificationDeliveryScopeSchema.parse(scope);
    if (!Number.isFinite(now.getTime())) throw invalid();
    return this.database.db.transaction(async db => {
      const rows = await db.select({delivery: claimable, accountStatus: users.status, currentEmail: users.email, emailEnabled: notificationPreferences.emailEnabled}).from(claimable)
        .innerJoin(notifications,eq(notifications.id,claimable.notificationId))
        .innerJoin(users,eq(users.id,notifications.recipientUserId))
        .leftJoin(notificationPreferences,eq(notificationPreferences.userId,users.id))
        .where(and(or(isNull(claimable.provider), eq(claimable.provider, configuredProvider)),
          selectedScope ? eq(notifications.recipientUserId, selectedScope.recipientUserId) : undefined,
          selectedScope ? gte(notifications.createdAt, selectedScope.startsAt) : undefined,
          or(and(inArray(claimable.status, [NOTIFICATION_EMAIL.status.pending, NOTIFICATION_EMAIL.status.retry]), lte(claimable.nextAttemptAt, now)),
            and(eq(claimable.status, NOTIFICATION_EMAIL.status.processing), lte(claimable.leaseUntil, now)))))
        .orderBy(asc(claimable.nextAttemptAt), asc(claimable.id)).limit(NOTIFICATION_EMAIL.limits.batch)
        .for(NOTIFICATION_EMAIL.lock, {of: claimable, skipLocked: true});
      const claimed: ClaimedNotificationEmail[] = [];
      for (const {delivery, accountStatus, currentEmail, emailEnabled} of rows) {
        // Mailpit has no deduplication contract: a crashed in-flight request must not be reposted.
        if (delivery.status === NOTIFICATION_EMAIL.status.processing && delivery.provider === EMAIL_PROVIDER.mailpit) {
          await db.update(deliveries).set({status: NOTIFICATION_EMAIL.status.uncertain, lastFailure: EMAIL_DELIVERY.failure.transport,
            leaseToken: null, leaseUntil: null, updatedAt: now}).where(eq(deliveries.id, delivery.id));
          continue;
        }
        if(emailEnabled===false){
          await db.update(deliveries).set({status:NOTIFICATION_EMAIL.status.cancelled,lastFailure:NOTIFICATION_PREFERENCES.failure.disabled,
            leaseToken:null,leaseUntil:null,updatedAt:now}).where(eq(deliveries.id,delivery.id));
          continue;
        }
        if (accountStatus === NOTIFICATION_EMAIL.account.deleted || currentEmail !== delivery.recipientAddress) {
          await db.update(deliveries).set({status: NOTIFICATION_EMAIL.status.cancelled, leaseToken: null, leaseUntil: null, updatedAt: now}).where(eq(deliveries.id, delivery.id));
          continue;
        }
        if (delivery.firstAttemptAt && now.getTime() >= delivery.firstAttemptAt.getTime() + EMAIL_DELIVERY.limits.idempotencyWindowMs) {
          await db.update(deliveries).set({status: NOTIFICATION_EMAIL.status.uncertain, lastFailure: EMAIL_DELIVERY.failure.window,
            leaseToken: null, leaseUntil: null, updatedAt: now}).where(eq(deliveries.id, delivery.id));
          continue;
        }
        if (delivery.firstAttemptAt && (delivery.senderName === null || delivery.senderAddress === null || delivery.provider === null)) throw invalid();
        const from = delivery.firstAttemptAt ? {name: delivery.senderName!, address: delivery.senderAddress!} : configured;
        const email = transactionalEmailSchema.parse({deliveryId: delivery.id, firstAttemptAt: delivery.firstAttemptAt ?? now, from,
          to: delivery.recipientAddress, subject: delivery.subject, text: delivery.bodyText});
        const leaseToken = randomUUID(), attempts = delivery.attempts + NOTIFICATION_EMAIL.limits.attemptStep;
        const [updated] = await db.update(deliveries).set({status: NOTIFICATION_EMAIL.status.processing, attempts, leaseToken,
          leaseUntil: new Date(now.getTime() + NOTIFICATION_EMAIL.limits.leaseMs), firstAttemptAt: email.firstAttemptAt,
          provider: configuredProvider, senderName: email.from.name, senderAddress: email.from.address, updatedAt: now})
          .where(eq(deliveries.id, delivery.id)).returning({id: deliveries.id});
        if (!updated) throw invalid();
        claimed.push({id: updated.id, leaseToken, attempts, provider: configuredProvider, email});
      }
      return claimed;
    });
  }

  async finish(claim: ClaimedNotificationEmail, result: EmailTransportResult, now = new Date()): Promise<boolean> {
    const provider = emailProviderSchema.parse(claim.provider);
    if (!Number.isFinite(now.getTime()) || now.getTime() < claim.email.firstAttemptAt.getTime()) throw invalid();
    const state: Partial<typeof deliveries.$inferInsert> = {leaseToken: null, leaseUntil: null, updatedAt: now};
    switch (result.outcome) {
    case EMAIL_DELIVERY.outcome.accepted:
      if (!emailProviderReceiptSchema.safeParse(result.providerMessageId).success) throw invalid();
      state.status = NOTIFICATION_EMAIL.status.accepted; state.providerMessageId = result.providerMessageId; state.acceptedAt = now; state.lastFailure = null;
      break;
    case EMAIL_DELIVERY.outcome.rejected:
      state.status = NOTIFICATION_EMAIL.status.rejected; state.lastFailure = result.reason;
      break;
    case EMAIL_DELIVERY.outcome.expired:
      state.status = NOTIFICATION_EMAIL.status.uncertain; state.lastFailure = result.reason;
      break;
    case EMAIL_DELIVERY.outcome.retry:
    case EMAIL_DELIVERY.outcome.unknown: {
      if (result.outcome === EMAIL_DELIVERY.outcome.unknown && provider === EMAIL_PROVIDER.mailpit) {
        state.status = NOTIFICATION_EMAIL.status.uncertain; state.lastFailure = result.reason;
        break;
      }
      const delay = Math.min(NOTIFICATION_EMAIL.limits.maximumRetryMs,
        NOTIFICATION_EMAIL.limits.firstRetryMs * NOTIFICATION_EMAIL.limits.retryFactor ** (claim.attempts - NOTIFICATION_EMAIL.limits.attemptStep));
      state.status = NOTIFICATION_EMAIL.status.retry; state.lastFailure = result.reason; state.nextAttemptAt = new Date(now.getTime() + delay);
      break;
    }
    }
    const [updated] = await this.database.db.update(deliveries).set(state)
      .where(and(eq(deliveries.id, claim.id), eq(deliveries.status, NOTIFICATION_EMAIL.status.processing),
        eq(deliveries.provider, provider), eq(deliveries.leaseToken, claim.leaseToken), eq(deliveries.attempts, claim.attempts))).returning({id: deliveries.id});
    return updated !== undefined;
  }
}
function invalid() { return new InternalServerErrorException(NOTIFICATION_EMAIL.failure.persisted); }
