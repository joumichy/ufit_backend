import {readFileSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {z} from 'zod';
import type {AppEnv} from '../../../config/env';
import {notificationIdentifierSchema} from '../domain/notification.contract';
import type {NotificationDeliveryScope} from '../domain/notification-delivery-scope';
import {NOTIFICATION_EMAIL} from '../domain/notification-email.contract';
import {APNS} from './apns-protocol';
import type {ApnsConfiguration} from './apns-push.transport';
import {PUSH_DELIVERY} from '../domain/push-delivery';

export const DEVELOPMENT_NOTIFICATIONS = {
  environment: 'development', protocol: 'http:', rootPath: '/',
  loopbackHosts: ['127.0.0.1', 'localhost', '[::1]'],
  senderAddress: 'no-reply@ufit.invalid',
  fileEncoding: 'utf8',
} as const;

const absolutePath = z.string().refine(isAbsolute);
export const developmentNotificationsSchema = z.object({
  recipientUserId: notificationIdentifierSchema,
  startsAt: z.iso.datetime(),
  mailpitOrigin: z.url().refine(value => {
    const url = new URL(value);
    return url.protocol === DEVELOPMENT_NOTIFICATIONS.protocol
      && DEVELOPMENT_NOTIFICATIONS.loopbackHosts.some(host => host === url.hostname)
      && url.pathname === DEVELOPMENT_NOTIFICATIONS.rootPath && !url.username && !url.password && !url.search && !url.hash;
  }),
  appleRegistryPath: absolutePath,
  emailEnabled: z.boolean(),
  pushEnabled: z.boolean(),
}).strict();

type DevelopmentNotificationsFile = z.infer<typeof developmentNotificationsSchema>;
export interface DevelopmentNotificationsConfiguration extends DevelopmentNotificationsFile {scope: NotificationDeliveryScope;}

export function developmentNotificationsConfiguration(env: AppEnv): DevelopmentNotificationsConfiguration | undefined {
  const path = env.UFIT_DEVELOPMENT_NOTIFICATIONS_CONFIG;
  if (!path) return undefined;
  if (env.NODE_ENV !== DEVELOPMENT_NOTIFICATIONS.environment || env.NOTIFICATION_EMAIL_ENABLED || env.NOTIFICATION_PUSH_ENABLED || !isAbsolute(path)) {
    throw new Error(NOTIFICATION_EMAIL.failure.configuration);
  }
  try {
    const value = developmentNotificationsSchema.parse(JSON.parse(readFileSync(path, DEVELOPMENT_NOTIFICATIONS.fileEncoding)));
    return {...value, scope: {recipientUserId: value.recipientUserId, startsAt: new Date(value.startsAt)}};
  } catch { throw new Error(NOTIFICATION_EMAIL.failure.configuration); }
}

const appleRegistrySchema = z.object({
  team_id: z.string().regex(APNS.jwt.identifier),
  bundle_id: z.literal(APNS.topic),
  apns: z.object({key_id: z.string().regex(APNS.jwt.identifier), private_key_path: absolutePath}).passthrough(),
}).passthrough();

export function developmentApnsConfiguration(path: string): ApnsConfiguration {
  try {
    const registry = appleRegistrySchema.parse(JSON.parse(readFileSync(path, DEVELOPMENT_NOTIFICATIONS.fileEncoding)));
    return {environment: PUSH_DELIVERY.environment.development, keyId: registry.apns.key_id,
      teamId: registry.team_id, privateKey: readFileSync(registry.apns.private_key_path, DEVELOPMENT_NOTIFICATIONS.fileEncoding)};
  } catch { throw new Error(PUSH_DELIVERY.failure.configuration); }
}
