import {z} from 'zod';
import {EMAIL_DELIVERY, emailProviderReceiptSchema, transactionalEmailSchema,
  type TransactionalEmail, type EmailTransport, type EmailTransportResult} from '../domain/email-delivery';
import {developmentNotificationsSchema} from './development-notifications.configuration';

export const MAILPIT_EMAIL = {
  path: '/api/v1/send', method: 'POST', contentType: 'Content-Type', json: 'application/json', redirect: 'error',
  status: {accepted: 200, clientMinimum: 400, clientMaximum: 499},
} as const;
const configurationSchema = z.object({origin: developmentNotificationsSchema.shape.mailpitOrigin,
  timeoutMs: z.number().int().positive().max(EMAIL_DELIVERY.limits.maximumTimeoutMs)}).strict();
const acceptedSchema = z.object({ID: emailProviderReceiptSchema});

export class MailpitEmailTransport implements EmailTransport {
  constructor(private readonly configuration: z.infer<typeof configurationSchema>, private readonly request: typeof fetch = fetch) {}

  async send(raw: TransactionalEmail, now = new Date()): Promise<EmailTransportResult> {
    const configuration = configurationSchema.safeParse(this.configuration), delivery = transactionalEmailSchema.safeParse(raw);
    if (!configuration.success) return {outcome: EMAIL_DELIVERY.outcome.rejected, reason: EMAIL_DELIVERY.failure.configuration};
    if (!delivery.success || !Number.isFinite(now.getTime()) || delivery.data.firstAttemptAt.getTime() > now.getTime()) {
      return {outcome: EMAIL_DELIVERY.outcome.rejected, reason: EMAIL_DELIVERY.failure.input};
    }
    const value = delivery.data;
    try {
      const response = await this.request(new URL(MAILPIT_EMAIL.path, configuration.data.origin), {
        method: MAILPIT_EMAIL.method, redirect: MAILPIT_EMAIL.redirect,
        headers: {[MAILPIT_EMAIL.contentType]: MAILPIT_EMAIL.json},
        body: JSON.stringify({From: {Name: value.from.name, Email: value.from.address}, To: [{Email: value.to}],
          Subject: value.subject, Text: value.text}),
        signal: AbortSignal.timeout(configuration.data.timeoutMs),
      });
      if (response.status === MAILPIT_EMAIL.status.accepted) {
        const receipt = acceptedSchema.safeParse(await response.json());
        return receipt.success ? {outcome: EMAIL_DELIVERY.outcome.accepted, providerMessageId: receipt.data.ID}
          : {outcome: EMAIL_DELIVERY.outcome.unknown, reason: EMAIL_DELIVERY.failure.response};
      }
      if (response.status >= MAILPIT_EMAIL.status.clientMinimum && response.status <= MAILPIT_EMAIL.status.clientMaximum) {
        return {outcome: EMAIL_DELIVERY.outcome.rejected, reason: EMAIL_DELIVERY.failure.request};
      }
      return {outcome: EMAIL_DELIVERY.outcome.unknown, reason: EMAIL_DELIVERY.failure.response};
    } catch { return {outcome: EMAIL_DELIVERY.outcome.unknown, reason: EMAIL_DELIVERY.failure.transport}; }
  }
}
