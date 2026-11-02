import {z} from 'zod';

export const NOTIFICATION = {
  resource: {creatorApplication:'creator_application',brandApplication:'brand_application',order:'order',shipment:'shipment',orderReturn:'order_return'},
  audience: {applicant:'applicant',customer:'customer',brand:'brand'},
  account: {deleted:'deleted'},
  limits: {minimum:1,eventKey:256},
  link: {prefix:'ufit://notifications/',paragraph:'\n\n'},
  failure: {missing:'Notification recipient is unavailable',changed:'Notification intent already exists with different content',persisted:'Notification state is invalid'},
} as const;
export const NOTIFICATION_RESOURCES = Object.values(NOTIFICATION.resource) as [typeof NOTIFICATION.resource[keyof typeof NOTIFICATION.resource], ...typeof NOTIFICATION.resource[keyof typeof NOTIFICATION.resource][]];
export const NOTIFICATION_AUDIENCES = Object.values(NOTIFICATION.audience) as [typeof NOTIFICATION.audience[keyof typeof NOTIFICATION.audience], ...typeof NOTIFICATION.audience[keyof typeof NOTIFICATION.audience][]];
export const notificationIdentifierSchema = z.uuid().transform(value=>value.toLowerCase());
export const notificationIntentSchema = z.object({
  eventKey:z.string().min(NOTIFICATION.limits.minimum).max(NOTIFICATION.limits.eventKey).refine(value=>value===value.trim()),
  recipientUserId:notificationIdentifierSchema,resourceType:z.enum(NOTIFICATION_RESOURCES),resourceId:notificationIdentifierSchema,
  audience:z.enum(NOTIFICATION_AUDIENCES),brandId:notificationIdentifierSchema.nullable(),
  subject:z.string().min(NOTIFICATION.limits.minimum),text:z.string().min(NOTIFICATION.limits.minimum),
}).strict().superRefine((value,context)=>{
  const application=value.resourceType===NOTIFICATION.resource.creatorApplication||value.resourceType===NOTIFICATION.resource.brandApplication;
  if(application !== (value.audience===NOTIFICATION.audience.applicant)||
    (value.audience===NOTIFICATION.audience.brand)!==(value.brandId!==null)) {
    context.addIssue({code:'custom',message:NOTIFICATION.failure.persisted});
  }
});
export type NotificationIntent=z.infer<typeof notificationIntentSchema>;

export interface NotificationsWriter {record(intent:NotificationIntent):Promise<string|null>;}
