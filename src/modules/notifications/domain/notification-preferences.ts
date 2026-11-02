import {z} from 'zod';
import {notificationIdentifierSchema} from './notification.contract';
export const NOTIFICATION_PREFERENCES = {
  route:{path:'preferences/:userId',userId:'userId'},validation:{customIssue:'custom'}, defaults:{emailEnabled:true,pushEnabled:true},
  revision:{absent:0,initial:1,step:1,maximum:2147483647},
  persistence:{lock:'update',one:1},
  failure:{invalid:{code:'notification_preferences_invalid',message:'Invalid notification preferences'},
    changed:{code:'notification_preferences_changed',message:'Notification preferences changed; refresh before saving'},
    inactive:{code:'notification_preferences_account_unavailable',message:'This account cannot change notification preferences'},
    foreign:{code:'notification_preferences_not_found',message:'Notification preferences unavailable for this account'},
    disabled:'recipient_preferences_disabled'},
} as const;
const revision=NOTIFICATION_PREFERENCES.revision;
export const notificationPreferencesInputSchema=z.object({expectedVersion:z.number().int().min(revision.absent).max(revision.maximum-revision.step),
  emailEnabled:z.boolean(),pushEnabled:z.boolean()}).strict();
export const notificationPreferencesSchema=z.object({userId:notificationIdentifierSchema,version:z.number().int().min(revision.absent).max(revision.maximum),
  emailEnabled:z.boolean(),pushEnabled:z.boolean(),updatedAt:z.iso.datetime().nullable()}).strict().superRefine((value,ctx)=>{
    if((value.version===revision.absent)!==(value.updatedAt===null)||value.version===revision.absent&&
      (value.emailEnabled!==NOTIFICATION_PREFERENCES.defaults.emailEnabled||value.pushEnabled!==NOTIFICATION_PREFERENCES.defaults.pushEnabled)) {
      ctx.addIssue({code:NOTIFICATION_PREFERENCES.validation.customIssue,message:NOTIFICATION_PREFERENCES.failure.invalid.message});
    }
  });
export type NotificationPreferences=z.infer<typeof notificationPreferencesSchema>;
export type NotificationPreferencesInput=z.infer<typeof notificationPreferencesInputSchema>;
