import {z} from 'zod';
import {notificationIdentifierSchema} from './notification.contract';
import {PUSH_DELIVERY as PUSH,pushDeliverySchema,type PushDelivery} from './push-delivery';

export const NOTIFICATION_PUSH = {
  status:{pending:'pending',reserved:'reserved',sending:'sending',retry:'retry',accepted:'accepted',rejected:'rejected',uncertain:'uncertain',cancelled:'cancelled',expired:'expired'},
  failure:{missing:'push_notification_unavailable',persisted:'push_delivery_state_invalid',association:'push_association_unavailable',
    environment:'push_environment_changed',lease:'push_attempt_response_unknown',cancelled:'push_retry_cancelled'},
  limits:{one:1,zero:0,step:1,batch:2,leaseMs:60_000,pollMs:2_000,lifetimeMs:86_400_000,firstRetryMs:5_000,credentialsRetryMs:900_000,maximumRetryMs:300_000,retryFactor:2},
  protocol:{outcome:'outcome'},
  lock:'update',claimAlias:'push_due_delivery',
} as const;
export const PUSH_STATUSES=Object.values(NOTIFICATION_PUSH.status);
export const reservedPushSchema=z.object({id:notificationIdentifierSchema,leaseToken:notificationIdentifierSchema,
  installationId:notificationIdentifierSchema,associationId:notificationIdentifierSchema}).strict();
export type ReservedNotificationPush=z.infer<typeof reservedPushSchema>;
export interface StartedNotificationPush extends ReservedNotificationPush {
  attempts:number;registrationId:string;attemptedAt:Date;push:PushDelivery;
}
export const pushTransportResultSchema=z.discriminatedUnion(NOTIFICATION_PUSH.protocol.outcome,[
  z.object({outcome:z.literal(PUSH.outcome.accepted),providerMessageId:notificationIdentifierSchema}).strict(),
  z.object({outcome:z.literal(PUSH.outcome.retry),reason:z.enum(Object.values(PUSH.failure)),retryAfterMs:z.number().int().nonnegative().safe()}).strict(),
  z.object({outcome:z.literal(PUSH.outcome.invalidDevice),reason:z.enum(Object.values(PUSH.failure)),invalidatedAt:z.date().nullable()}).strict(),
  z.object({outcome:z.enum([PUSH.outcome.rejected,PUSH.outcome.unknown,PUSH.outcome.expired]),reason:z.enum(Object.values(PUSH.failure))}).strict(),
]);
export const startedPushSchema=reservedPushSchema.extend({attempts:z.number().int().positive(),registrationId:notificationIdentifierSchema,
  attemptedAt:z.date(),push:pushDeliverySchema}).strict();
