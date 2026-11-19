import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {AppEnv} from '../src/config/env';
import {getEnv} from '../src/config/env';
import {developmentNotificationsConfiguration} from '../src/modules/notifications/infrastructure/development-notifications.configuration';
import {NotificationEmailsWorker} from '../src/modules/notifications/infrastructure/notification-emails.worker';
import {NotificationPushesWorker} from '../src/modules/notifications/infrastructure/notification-pushes.worker';
import {ApnsPushTransport} from '../src/modules/notifications/infrastructure/apns-push.transport';
import {PUSH_DELIVERY} from '../src/modules/notifications/domain/push-delivery';
import {EMAIL_PROVIDER} from '../src/modules/notifications/domain/email-delivery';
vi.mock('../src/config/env', () => ({getEnv: vi.fn()}));

const Fixture = {
  prefix: 'ufit-development-notification-contract-', config: 'notifications.json', apple: 'apple.json', key: 'key.p8', encoding: 'utf8',
  recipientUserId: '974490a2-32c5-470d-bbf6-05161ddf7b48', startsAt: '2026-11-19T09:00:00.000Z',
  origin: 'http://127.0.0.1:18025', remote: 'https://mailpit.example.test',
  senderName: 'Ufit', senderAddress: 'no-reply@ufit.invalid', bundleId: 'com.stellark.ufit',
  keyId: 'ABCDEFGHIJ', teamId: 'KLMNOPQRST', keyKind: 'ec', curve: 'prime256v1', keyType: 'pkcs8', format: 'pem',
  privateMode: 0o600, development: 'development', production: 'production', test: 'test',
  one: 1, zero: 0,
} as const;
let directory: string;
function fileConfiguration(extra: Record<string, unknown> = {}) {
  return {recipientUserId: Fixture.recipientUserId, startsAt: Fixture.startsAt, mailpitOrigin: Fixture.origin,
    appleRegistryPath: join(directory, Fixture.apple), emailEnabled: true, pushEnabled: false, ...extra};
}
function environment(extra: Record<string, unknown> = {}): AppEnv {
  return {NODE_ENV: Fixture.development, NOTIFICATION_EMAIL_ENABLED: false, NOTIFICATION_PUSH_ENABLED: false,
    UFIT_DEVELOPMENT_NOTIFICATIONS_CONFIG: join(directory, Fixture.config), ...extra} as AppEnv;
}
function configure(fileExtra: Record<string, unknown> = {}, envExtra: Record<string, unknown> = {}) {
  writeFileSync(join(directory, Fixture.config), JSON.stringify(fileConfiguration(fileExtra)), {mode: Fixture.privateMode});
  const env = environment(envExtra); vi.mocked(getEnv).mockReturnValue(env); return env;
}
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), Fixture.prefix)); vi.clearAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); rmSync(directory, {recursive: true}); });

describe('Scoped development notification configuration', () => {
  it('remains absent unless the exact private configuration path is selected', () => {
    expect(developmentNotificationsConfiguration(environment({UFIT_DEVELOPMENT_NOTIFICATIONS_CONFIG: undefined}))).toBeUndefined();
  });
  it.each([{NODE_ENV: Fixture.production}, {NODE_ENV: Fixture.test}, {NOTIFICATION_EMAIL_ENABLED: true}, {NOTIFICATION_PUSH_ENABLED: true}])
    ('rejects production or simultaneous global dispatch before any send: %j', extra => {
      expect(() => developmentNotificationsConfiguration(configure({}, extra))).toThrow();
    });
  it.each([{recipientUserId: Fixture.senderName}, {startsAt: Fixture.senderName}, {mailpitOrigin: Fixture.remote},
    {appleRegistryPath: Fixture.apple}, {emailEnabled: undefined}, {recipientId: Fixture.recipientUserId}])
    ('requires the canonical complete scope without aliases: %j', extra => {
      expect(() => developmentNotificationsConfiguration(configure(extra))).toThrow();
    });
  it('passes the exact account and cutoff to the email claim without enabling the global worker', async () => {
    configure(); const emails = {claim: vi.fn().mockResolvedValue([]), finish: vi.fn()};
    const worker = new NotificationEmailsWorker(emails); await worker.deliverDue();
    expect(emails.claim).toHaveBeenCalledWith({name: Fixture.senderName, address: Fixture.senderAddress}, expect.any(Date),
      {recipientUserId: Fixture.recipientUserId, startsAt: new Date(Fixture.startsAt)}, EMAIL_PROVIDER.mailpit);
    await worker.onModuleDestroy();
  });
  it('leaves a disabled channel idle without silently using Resend', async () => {
    configure({emailEnabled: false}); const emails = {claim: vi.fn(), finish: vi.fn()};
    const worker = new NotificationEmailsWorker(emails); await worker.deliverDue(); await worker.onModuleDestroy();
    expect(emails.claim).not.toHaveBeenCalled();
  });
  it('loads APNs material from its owning private registry and only claims sandbox for the same scope', async () => {
    configure({pushEnabled: true});
    const key = generateKeyPairSync(Fixture.keyKind, {namedCurve: Fixture.curve}).privateKey
      .export({type: Fixture.keyType, format: Fixture.format}).toString();
    writeFileSync(join(directory, Fixture.key), key, {mode: Fixture.privateMode});
    writeFileSync(join(directory, Fixture.apple), JSON.stringify({team_id: Fixture.teamId, bundle_id: Fixture.bundleId,
      apns: {key_id: Fixture.keyId, private_key_path: join(directory, Fixture.key)}}), {mode: Fixture.privateMode});
    const pushes = {claim: vi.fn().mockResolvedValue([]), start: vi.fn(), finish: vi.fn()};
    const send = vi.spyOn(ApnsPushTransport.prototype, 'send');
    const worker = new NotificationPushesWorker(pushes); await worker.deliverDue(); await worker.onModuleDestroy();
    expect(pushes.claim).toHaveBeenCalledWith(PUSH_DELIVERY.environment.development, expect.any(Date),
      {recipientUserId: Fixture.recipientUserId, startsAt: new Date(Fixture.startsAt)});
    expect(send).not.toHaveBeenCalled(); expect(pushes.claim).toHaveBeenCalledTimes(Fixture.one);
  });
});
