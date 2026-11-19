import {describe, expect, it} from 'vitest';
import {EMAIL_DELIVERY, type TransactionalEmail} from '../src/modules/notifications/domain/email-delivery';
import {MailpitEmailTransport} from '../src/modules/notifications/infrastructure/mailpit-email.transport';

const Fixture = {
  origin: 'http://127.0.0.1:18025', path: '/api/v1/send', method: 'POST',
  contentType: 'Content-Type', json: 'application/json',
  deliveryId: '56af53c0-c0a9-42fb-859e-052a3c6cd7bb', receipt: 'mailpit-opaque-receipt',
  anchor: '2026-11-19T09:00:00.000Z', now: '2026-11-19T09:00:01.000Z',
  name: 'Ufit', from: 'no-reply@ufit.invalid', recipient: 'customer@ufit.invalid',
  subject: 'Votre commande Ufit', text: 'Votre commande a été confirmée.', timeoutMs: 5_000,
  status: {ok: 200, invalid: 400, unauthorized: 401, rejected: 413, unavailable: 503},
  remote: 'https://mailpit.example.test', embeddedPassword: 'http://user:password@127.0.0.1:18025',
  one: 1, zero: 0,
} as const;
function delivery(): TransactionalEmail {
  return {deliveryId: Fixture.deliveryId, firstAttemptAt: new Date(Fixture.anchor),
    from: {name: Fixture.name, address: Fixture.from}, to: Fixture.recipient, subject: Fixture.subject, text: Fixture.text};
}
function response(body: unknown, status: number = Fixture.status.ok) {
  return new Response(JSON.stringify(body), {status, headers: {[Fixture.contentType]: Fixture.json}});
}
function configuration() { return {origin: Fixture.origin, timeoutMs: Fixture.timeoutMs}; }

describe('Development Mailpit transport boundary', () => {
  it('sends the documented JSON envelope and preserves the real opaque receipt', async () => {
    const requests: {url: RequestInfo | URL; init?: RequestInit}[] = [];
    const transport = new MailpitEmailTransport(configuration(), async (url, init) => {
      requests.push({url, init}); return response({ID: Fixture.receipt});
    });
    expect(await transport.send(delivery(), new Date(Fixture.now)))
      .toEqual({outcome: EMAIL_DELIVERY.outcome.accepted, providerMessageId: Fixture.receipt});
    expect(requests).toHaveLength(Fixture.one);
    const request = requests[Fixture.zero];
    expect(String(request.url)).toBe(Fixture.origin + Fixture.path);
    expect(request.init?.method).toBe(Fixture.method);
    expect(Object.fromEntries(new Headers(request.init?.headers))).toEqual({'content-type': Fixture.json});
    expect(JSON.parse(String(request.init?.body))).toEqual({From: {Name: Fixture.name, Email: Fixture.from},
      To: [{Email: Fixture.recipient}], Subject: Fixture.subject, Text: Fixture.text});
    expect(Fixture.receipt).not.toBe(Fixture.deliveryId);
  });
  it.each([Fixture.remote, Fixture.embeddedPassword, Fixture.origin + Fixture.path])
    ('rejects a non-local or non-origin destination before sending: %s', async origin => {
      let calls = Fixture.zero;
      const transport = new MailpitEmailTransport({...configuration(), origin}, async () => { calls++; return response({ID: Fixture.receipt}); });
      expect((await transport.send(delivery(), new Date(Fixture.now))).outcome).toBe(EMAIL_DELIVERY.outcome.rejected);
      expect(calls).toBe(Fixture.zero);
    });
  it('does not invent an accepted receipt from the delivery ID or an unrecognised response', async () => {
    for (const body of [{id: Fixture.receipt}, {ID: String()}, {ID: Fixture.text}, {}]) {
      const transport = new MailpitEmailTransport(configuration(), async () => response(body));
      expect(await transport.send(delivery(), new Date(Fixture.now)))
        .toEqual({outcome: EMAIL_DELIVERY.outcome.unknown, reason: EMAIL_DELIVERY.failure.response});
    }
  });
  it('makes a single attempt and reports a lost response as unknown', async () => {
    let calls = Fixture.zero;
    const transport = new MailpitEmailTransport(configuration(), async () => { calls++; throw new TypeError(); });
    expect(await transport.send(delivery(), new Date(Fixture.now)))
      .toEqual({outcome: EMAIL_DELIVERY.outcome.unknown, reason: EMAIL_DELIVERY.failure.transport});
    expect(calls).toBe(Fixture.one);
  });
  it.each([Fixture.status.invalid, Fixture.status.unauthorized, Fixture.status.rejected])
    ('keeps an explicit rejection separate from an unconfirmed request: %s', async status => {
      const transport = new MailpitEmailTransport(configuration(), async () => response({}, status));
      expect((await transport.send(delivery(), new Date(Fixture.now))).outcome).toBe(EMAIL_DELIVERY.outcome.rejected);
    });
  it('does not assume a server failure means the message was not accepted', async () => {
    const transport = new MailpitEmailTransport(configuration(), async () => response({}, Fixture.status.unavailable));
    expect((await transport.send(delivery(), new Date(Fixture.now))).outcome).toBe(EMAIL_DELIVERY.outcome.unknown);
  });
});
