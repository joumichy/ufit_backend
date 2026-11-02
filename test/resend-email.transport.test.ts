import {describe, expect, it} from 'vitest';
import {EMAIL_DELIVERY, type TransactionalEmail} from '../src/modules/notifications/domain/email-delivery';
import {ResendEmailTransport} from '../src/modules/notifications/infrastructure/resend-email.transport';

const FIXTURE = {
  deliveryId: '8de392a4-9161-4000-a927-57b826ce9d9a', providerId: '8de392a4-9161-4000-a927-57b826ce9d9b',
  anchor: '2026-11-01T10:00:00.000Z', now: '2026-11-01T10:00:01.000Z',
  fromName: 'Ufit', fromAddress: 'notifications@example.test', to: 'client@example.test',
  subject: 'Votre commande est confirmée', text: 'Votre commande Ufit est confirmée.',
  apiKey: 'provider-contract-fixture', timeoutMs: 5_000,
  wire: {url: 'https://api.resend.com/emails', method: 'POST', authorization: 'Authorization', bearer: 'Bearer ', jsonHeader: 'Content-Type', json: 'application/json',
    idempotencyHeader: 'Idempotency-Key', prefix: 'ufit-email/', mailbox: 'Ufit <notifications@example.test>', redirect: 'error'},
  statuses: {ok: 200, conflict: 409, limited: 429, down: 503, unauthenticated: 401, forbidden: 403, invalid: 422},
  error: {concurrent: 'concurrent_idempotent_requests', conflict: 'invalid_idempotent_request'},
  secondMs: 1_000,
} as const;
function delivery(): TransactionalEmail {
  return {deliveryId: FIXTURE.deliveryId, firstAttemptAt: new Date(FIXTURE.anchor),
    from: {name: FIXTURE.fromName, address: FIXTURE.fromAddress}, to: FIXTURE.to, subject: FIXTURE.subject, text: FIXTURE.text};
}
function configuration() { return {apiKey: FIXTURE.apiKey, timeoutMs: FIXTURE.timeoutMs}; }
function response(body: unknown, status: number) { return new Response(JSON.stringify(body), {status, headers: {[FIXTURE.wire.jsonHeader]: FIXTURE.wire.json}}); }
function transportReturning(body: unknown, status: number) {
  return new ResendEmailTransport(configuration(), async () => response(body, status));
}

describe('Resend transactional email boundary', () => {
  it('sends the exact provider envelope and a stable delivery key without app credentials', async () => {
    const requests: {url: RequestInfo | URL; init: RequestInit | undefined}[] = [];
    const transport = new ResendEmailTransport(configuration(), async (url, init) => {
      requests.push({url, init}); return response({id: FIXTURE.providerId}, FIXTURE.statuses.ok);
    });
    const input = delivery();
    expect(await transport.send(input, new Date(FIXTURE.now))).toEqual({outcome: EMAIL_DELIVERY.outcome.accepted, providerMessageId: FIXTURE.providerId});
    expect(await transport.send(input, new Date(FIXTURE.now))).toEqual({outcome: EMAIL_DELIVERY.outcome.accepted, providerMessageId: FIXTURE.providerId});
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.url).toBe(FIXTURE.wire.url); expect(request.init?.method).toBe(FIXTURE.wire.method);
      expect(request.init?.redirect).toBe(FIXTURE.wire.redirect);
      expect(new Headers(request.init?.headers).get(FIXTURE.wire.authorization)).toBe(FIXTURE.wire.bearer + FIXTURE.apiKey);
      expect(new Headers(request.init?.headers).get(FIXTURE.wire.idempotencyHeader)).toBe(FIXTURE.wire.prefix + FIXTURE.deliveryId);
      expect(JSON.parse(request.init?.body as string)).toEqual({from: FIXTURE.wire.mailbox, to: [FIXTURE.to], subject: FIXTURE.subject, text: FIXTURE.text});
    }
    expect(requests.at(0)?.init?.body).toBe(requests.at(1)?.init?.body);
  });
  it('keeps the same idempotency identity for an equivalent uppercase UUID', async () => {
    let key: string | null = null;
    const transport = new ResendEmailTransport(configuration(), async (_, init) => {
      key = new Headers(init?.headers).get(FIXTURE.wire.idempotencyHeader);
      return response({id: FIXTURE.providerId}, FIXTURE.statuses.ok);
    });
    await transport.send({...delivery(), deliveryId: FIXTURE.deliveryId.toUpperCase()}, new Date(FIXTURE.now));
    expect(key).toBe(FIXTURE.wire.prefix + FIXTURE.deliveryId);
  });
  it('does not issue a request after the provider deduplication window or near its timeout boundary', async () => {
    let requests = 0;
    const transport = new ResendEmailTransport(configuration(), async () => { requests++; return response({id: FIXTURE.providerId}, FIXTURE.statuses.ok); });
    for (const offset of [EMAIL_DELIVERY.limits.idempotencyWindowMs, EMAIL_DELIVERY.limits.idempotencyWindowMs - FIXTURE.timeoutMs]) {
      expect(await transport.send(delivery(), new Date(Date.parse(FIXTURE.anchor) + offset))).toEqual({outcome: EMAIL_DELIVERY.outcome.expired, reason: EMAIL_DELIVERY.failure.window});
    }
    expect(requests).toBe(0);
  });
  it('rejects malformed data and a future anchor before the external side effect', async () => {
    let requests = 0;
    const transport = new ResendEmailTransport(configuration(), async () => { requests++; return response({id: FIXTURE.providerId}, FIXTURE.statuses.ok); });
    const malformed = {...delivery(), deliveryId: FIXTURE.fromName};
    expect((await transport.send(malformed, new Date(FIXTURE.now))).outcome).toBe(EMAIL_DELIVERY.outcome.rejected);
    expect((await transport.send(delivery(), new Date(Date.parse(FIXTURE.anchor) - FIXTURE.secondMs))).outcome).toBe(EMAIL_DELIVERY.outcome.rejected);
    expect(requests).toBe(0);
  });
  it('requires the canonical provider identifier before accepting an email', async () => {
    const result = await transportReturning({message: FIXTURE.text}, FIXTURE.statuses.ok).send(delivery(), new Date(FIXTURE.now));
    expect(result).toEqual({outcome: EMAIL_DELIVERY.outcome.unknown, reason: EMAIL_DELIVERY.failure.response});
  });
  it('does not send a second request after a response is lost', async () => {
    let requests = 0;
    const transport = new ResendEmailTransport(configuration(), async () => { requests++; throw new TypeError(FIXTURE.text); });
    expect(await transport.send(delivery(), new Date(FIXTURE.now))).toEqual({outcome: EMAIL_DELIVERY.outcome.unknown, reason: EMAIL_DELIVERY.failure.transport});
    expect(requests).toBe(1);
  });
  it('distinguishes an in-progress idempotent request from a changed envelope', async () => {
    expect(await transportReturning({name: FIXTURE.error.concurrent}, FIXTURE.statuses.conflict).send(delivery(), new Date(FIXTURE.now)))
      .toEqual({outcome: EMAIL_DELIVERY.outcome.retry, reason: EMAIL_DELIVERY.failure.concurrent});
    expect(await transportReturning({name: FIXTURE.error.conflict}, FIXTURE.statuses.conflict).send(delivery(), new Date(FIXTURE.now)))
      .toEqual({outcome: EMAIL_DELIVERY.outcome.rejected, reason: EMAIL_DELIVERY.failure.payloadConflict});
  });
  it('keeps provider rejections separate from transient failures and never reports them as accepted', async () => {
    for (const [status, outcome, reason] of [
      [FIXTURE.statuses.limited, EMAIL_DELIVERY.outcome.retry, EMAIL_DELIVERY.failure.rateLimit],
      [FIXTURE.statuses.down, EMAIL_DELIVERY.outcome.retry, EMAIL_DELIVERY.failure.unavailable],
      [FIXTURE.statuses.unauthenticated, EMAIL_DELIVERY.outcome.rejected, EMAIL_DELIVERY.failure.credentials],
      [FIXTURE.statuses.forbidden, EMAIL_DELIVERY.outcome.rejected, EMAIL_DELIVERY.failure.forbidden],
      [FIXTURE.statuses.invalid, EMAIL_DELIVERY.outcome.rejected, EMAIL_DELIVERY.failure.request],
    ] as const) {
      expect(await transportReturning({}, status).send(delivery(), new Date(FIXTURE.now))).toEqual({outcome, reason});
    }
  });
  it('does not attempt delivery with missing configuration', async () => {
    let requests = 0;
    const transport = new ResendEmailTransport({...configuration(), apiKey: String()}, async () => { requests++; return response({}, FIXTURE.statuses.ok); });
    expect(await transport.send(delivery(), new Date(FIXTURE.now))).toEqual({outcome: EMAIL_DELIVERY.outcome.rejected, reason: EMAIL_DELIVERY.failure.configuration});
    expect(requests).toBe(0);
  });
});
