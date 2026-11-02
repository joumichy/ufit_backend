import {z} from 'zod';

export const EMAIL_DELIVERY = {
  outcome: {accepted: 'accepted', retry: 'retry', rejected: 'rejected', unknown: 'unknown', expired: 'expired'},
  failure: {input: 'invalid_delivery', configuration: 'email_configuration_unavailable', transport: 'provider_response_unknown', response: 'provider_response_invalid',
    credentials: 'provider_credentials_rejected', forbidden: 'provider_request_forbidden', request: 'provider_request_rejected', payloadConflict: 'provider_payload_conflict', unavailable: 'provider_unavailable',
    rateLimit: 'provider_rate_limited', concurrent: 'provider_request_in_progress', window: 'provider_idempotency_window_expired'},
  limits: {defaultTimeoutMs: 10_000, maximumTimeoutMs: 15_000, minimum: 1, idempotencyWindowMs: 24 * 60 * 60 * 1_000},
} as const;

export const transactionalEmailSchema = z.object({
  deliveryId: z.uuid().transform(value => value.toLowerCase()),
  firstAttemptAt: z.date(),
  from: z.object({name: z.string().trim().min(EMAIL_DELIVERY.limits.minimum).regex(/^[^<>\r\n]+$/), address: z.email()}).strict(),
  to: z.email(),
  subject: z.string().min(EMAIL_DELIVERY.limits.minimum),
  text: z.string().min(EMAIL_DELIVERY.limits.minimum),
}).strict();

export type TransactionalEmail = z.infer<typeof transactionalEmailSchema>;
export type EmailDeliveryFailure = typeof EMAIL_DELIVERY.failure[keyof typeof EMAIL_DELIVERY.failure];
export type EmailTransportResult =
  | {outcome: typeof EMAIL_DELIVERY.outcome.accepted; providerMessageId: string}
  | {outcome: typeof EMAIL_DELIVERY.outcome.retry; reason: EmailDeliveryFailure}
  | {outcome: typeof EMAIL_DELIVERY.outcome.rejected; reason: EmailDeliveryFailure}
  | {outcome: typeof EMAIL_DELIVERY.outcome.unknown; reason: EmailDeliveryFailure}
  | {outcome: typeof EMAIL_DELIVERY.outcome.expired; reason: EmailDeliveryFailure};
