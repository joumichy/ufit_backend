import {z} from 'zod';
import {EMAIL_DELIVERY, transactionalEmailSchema, type TransactionalEmail, type EmailTransportResult} from '../domain/email-delivery';

export const RESEND_EMAIL = {
  origin: 'https://api.resend.com', rootPath: '/', path: '/emails', method: 'POST',
  header: {authorization: 'Authorization', contentType: 'Content-Type', idempotency: 'Idempotency-Key'},
  bearer: 'Bearer ', json: 'application/json', keyPrefix: 'ufit-email/', redirect: 'error',
  mailboxOpen: ' <', mailboxClose: '>',
  status: {success: 200, redirect: 300, unauthenticated: 401, forbidden: 403, conflict: 409, rateLimit: 429, unavailable: 500},
  error: {payloadConflict: 'invalid_idempotent_request', concurrent: 'concurrent_idempotent_requests'},
} as const;

export interface ResendEmailConfiguration {apiKey: string; timeoutMs: number;}
const configurationSchema = z.object({apiKey: z.string().trim().min(EMAIL_DELIVERY.limits.minimum),
  timeoutMs: z.number().int().positive().max(EMAIL_DELIVERY.limits.maximumTimeoutMs)}).strict();
const acceptedSchema = z.object({id: z.uuid()});
const providerErrorSchema = z.object({name: z.string()});

export class ResendEmailTransport {
  constructor(private readonly configuration: ResendEmailConfiguration, private readonly request: typeof fetch = fetch) {}

  async send(delivery: TransactionalEmail, now = new Date()): Promise<EmailTransportResult> {
    const parsed = transactionalEmailSchema.safeParse(delivery), configured = configurationSchema.safeParse(this.configuration);
    if (!configured.success) return {outcome: EMAIL_DELIVERY.outcome.rejected, reason: EMAIL_DELIVERY.failure.configuration};
    if (!parsed.success || !Number.isFinite(now.getTime()) || delivery.firstAttemptAt.getTime() > now.getTime()) {
      return {outcome: EMAIL_DELIVERY.outcome.rejected, reason: EMAIL_DELIVERY.failure.input};
    }
    // The outbox must persist this anchor and the complete envelope before the first request.
    // A retry is allowed only while the provider can still deduplicate the same payload.
    if (now.getTime() + configured.data.timeoutMs >= delivery.firstAttemptAt.getTime() + EMAIL_DELIVERY.limits.idempotencyWindowMs) {
      return {outcome: EMAIL_DELIVERY.outcome.expired, reason: EMAIL_DELIVERY.failure.window};
    }
    const value = parsed.data;
    try {
      const response = await this.request(RESEND_EMAIL.origin + RESEND_EMAIL.path, {
        method: RESEND_EMAIL.method,
        redirect: RESEND_EMAIL.redirect,
        headers: {
          [RESEND_EMAIL.header.authorization]: RESEND_EMAIL.bearer + configured.data.apiKey,
          [RESEND_EMAIL.header.contentType]: RESEND_EMAIL.json,
          [RESEND_EMAIL.header.idempotency]: RESEND_EMAIL.keyPrefix + value.deliveryId,
        },
        body: JSON.stringify({from: value.from.name + RESEND_EMAIL.mailboxOpen + value.from.address + RESEND_EMAIL.mailboxClose, to: [value.to], subject: value.subject, text: value.text}),
        signal: AbortSignal.timeout(configured.data.timeoutMs),
      });
      if (response.status >= RESEND_EMAIL.status.success && response.status < RESEND_EMAIL.status.redirect) {
        const accepted = acceptedSchema.safeParse(await response.json());
        return accepted.success
          ? {outcome: EMAIL_DELIVERY.outcome.accepted, providerMessageId: accepted.data.id}
          : {outcome: EMAIL_DELIVERY.outcome.unknown, reason: EMAIL_DELIVERY.failure.response};
      }
      if (response.status === RESEND_EMAIL.status.conflict) {
        const error = providerErrorSchema.safeParse(await response.json());
        if (error.success && error.data.name === RESEND_EMAIL.error.concurrent) {
          return {outcome: EMAIL_DELIVERY.outcome.retry, reason: EMAIL_DELIVERY.failure.concurrent};
        }
        if (error.success && error.data.name === RESEND_EMAIL.error.payloadConflict) {
          return {outcome: EMAIL_DELIVERY.outcome.rejected, reason: EMAIL_DELIVERY.failure.payloadConflict};
        }
        return {outcome: EMAIL_DELIVERY.outcome.unknown, reason: EMAIL_DELIVERY.failure.response};
      }
      if (response.status === RESEND_EMAIL.status.rateLimit) return {outcome: EMAIL_DELIVERY.outcome.retry, reason: EMAIL_DELIVERY.failure.rateLimit};
      if (response.status >= RESEND_EMAIL.status.unavailable) return {outcome: EMAIL_DELIVERY.outcome.retry, reason: EMAIL_DELIVERY.failure.unavailable};
      if (response.status === RESEND_EMAIL.status.unauthenticated) {
        return {outcome: EMAIL_DELIVERY.outcome.rejected, reason: EMAIL_DELIVERY.failure.credentials};
      }
      if (response.status === RESEND_EMAIL.status.forbidden) return {outcome: EMAIL_DELIVERY.outcome.rejected, reason: EMAIL_DELIVERY.failure.forbidden};
      return {outcome: EMAIL_DELIVERY.outcome.rejected, reason: EMAIL_DELIVERY.failure.request};
    } catch {
      return {outcome: EMAIL_DELIVERY.outcome.unknown, reason: EMAIL_DELIVERY.failure.transport};
    }
  }
}
