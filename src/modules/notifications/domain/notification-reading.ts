import {z} from 'zod';
import {NOTIFICATION,notificationIdentifierSchema} from './notification.contract';

export const NOTIFICATION_READING = {
  route:{root:'notifications',detail:':id',id:'id'},
  protocol:{kind:'kind'},
  response:{cacheHeader:'Cache-Control',cachePolicy:'private, no-store'},
  account:{readable:['active','onboarding'] as const},
  destination:{creatorApplication:NOTIFICATION.resource.creatorApplication,brandApplication:NOTIFICATION.resource.brandApplication,
    customerOrder:'customer_order',brandOrder:'brand_order',customerReturn:'customer_return',brandReturn:'brand_return'},
  failure:{missing:{code:'notification_unavailable',message:'Notification unavailable for this account'},
    inactive:{code:'notification_account_inactive',message:'An active account is required'},
    persisted:{code:'notification_persisted_invalid',message:'The notification requires correction'}},
} as const;
const kind=NOTIFICATION_READING.destination;
export const notificationDestinationSchema=z.discriminatedUnion(NOTIFICATION_READING.protocol.kind,[
  z.object({kind:z.literal(kind.creatorApplication),id:notificationIdentifierSchema}).strict(),
  z.object({kind:z.literal(kind.brandApplication),id:notificationIdentifierSchema}).strict(),
  z.object({kind:z.literal(kind.customerOrder),id:notificationIdentifierSchema}).strict(),
  z.object({kind:z.literal(kind.brandOrder),id:notificationIdentifierSchema,brandId:notificationIdentifierSchema}).strict(),
  z.object({kind:z.literal(kind.customerReturn),id:notificationIdentifierSchema,orderId:notificationIdentifierSchema}).strict(),
  z.object({kind:z.literal(kind.brandReturn),id:notificationIdentifierSchema,brandId:notificationIdentifierSchema}).strict(),
]);
export const notificationDetailSchema=z.object({id:notificationIdentifierSchema,subject:z.string().min(NOTIFICATION.limits.minimum),
  text:z.string().min(NOTIFICATION.limits.minimum),createdAt:z.iso.datetime(),destination:notificationDestinationSchema}).strict();
export type NotificationDestination=z.infer<typeof notificationDestinationSchema>;
export type NotificationDetail=z.infer<typeof notificationDetailSchema>;
