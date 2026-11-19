import {z} from 'zod';
import {notificationIdentifierSchema} from './notification.contract';

export const notificationDeliveryScopeSchema = z.object({
  recipientUserId: notificationIdentifierSchema,
  startsAt: z.date(),
}).strict();

export type NotificationDeliveryScope = z.infer<typeof notificationDeliveryScopeSchema>;
