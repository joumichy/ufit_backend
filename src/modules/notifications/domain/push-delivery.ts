import {z} from 'zod';
import {notificationIdentifierSchema} from './notification.contract';

export const PUSH_DELIVERY = {
  environment: {development:'development',production:'production'},
  outcome: {accepted:'accepted',retry:'retry',rejected:'rejected',unknown:'unknown',expired:'expired',invalidDevice:'invalid_device'},
  failure: {input:'invalid_push_delivery',configuration:'push_configuration_unavailable',transport:'push_response_unknown',
    response:'push_response_invalid',unavailable:'push_service_unavailable',credentials:'push_credentials_rejected',
    request:'push_request_rejected',rate:'push_rate_limited',tokenRate:'push_token_updates_limited',device:'push_device_invalid',expired:'push_delivery_expired',closed:'push_transport_closed'},
  token: {encoding:/^(?:[0-9a-f]{2})+$/},
  copy: {title:'Ufit',body:'Vous avez une mise à jour.'},
} as const;

export const pushDeliverySchema=z.object({
  deliveryId:notificationIdentifierSchema,
  notificationId:notificationIdentifierSchema,
  environment:z.enum([PUSH_DELIVERY.environment.development,PUSH_DELIVERY.environment.production]),
  deviceToken:z.string().regex(PUSH_DELIVERY.token.encoding),
  expiresAt:z.date(),
}).strict();
export type PushDelivery=z.infer<typeof pushDeliverySchema>;
export type PushEnvironment=PushDelivery['environment'];
export type PushFailure=typeof PUSH_DELIVERY.failure[keyof typeof PUSH_DELIVERY.failure];
export type PushTransportResult=
  | {outcome:typeof PUSH_DELIVERY.outcome.accepted;providerMessageId:string}
  | {outcome:typeof PUSH_DELIVERY.outcome.retry;reason:PushFailure;retryAfterMs:number}
  | {outcome:typeof PUSH_DELIVERY.outcome.invalidDevice;reason:PushFailure;invalidatedAt:Date|null}
  | {outcome:typeof PUSH_DELIVERY.outcome.rejected|typeof PUSH_DELIVERY.outcome.unknown|typeof PUSH_DELIVERY.outcome.expired;reason:PushFailure};
