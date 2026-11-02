import {z} from 'zod';
import {EMAIL_DELIVERY} from './email-delivery';

export const NOTIFICATION_EMAIL = {
  status: {pending: 'pending', processing: 'processing', retry: 'retry', accepted: 'accepted', rejected: 'rejected', uncertain: 'uncertain', cancelled: 'cancelled'},
  account: {deleted: 'deleted'},
  limits: {leaseMs: 60_000, batch: 2, pollMs: 2_000, firstRetryMs: 5_000, maximumRetryMs: 300_000, retryFactor: 2, initialAttempts: 0, attemptStep: 1, first: 0},
  senderName:'Ufit',
  failure: {configuration:'Ufit email notification configuration is incomplete or invalid',missing: 'Notification recipient is unavailable', changed: 'Notification intent already exists with different content', persisted: 'Notification delivery state is invalid'},
  lock: 'update', claimAlias: 'notification_delivery',
} as const;
export const NOTIFICATION_EMAIL_STATUSES = Object.values(NOTIFICATION_EMAIL.status);
export const notificationSenderSchema = z.object({name: z.string().trim().min(EMAIL_DELIVERY.limits.minimum).regex(/^[^<>\r\n]+$/), address: z.email()}).strict();
export type NotificationSender = z.infer<typeof notificationSenderSchema>;
