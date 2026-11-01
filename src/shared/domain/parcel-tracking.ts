import {z} from 'zod';

export const PARCEL_TRACKING = {
  minimumText: 1, carrierMaximum: 120, numberMaximum: 160, https: 'https:',
} as const;
export const parcelTrackingFields = {
  carrier: z.string().trim().min(PARCEL_TRACKING.minimumText).max(PARCEL_TRACKING.carrierMaximum),
  trackingNumber: z.string().trim().min(PARCEL_TRACKING.minimumText).max(PARCEL_TRACKING.numberMaximum),
  trackingUrl: z.url().refine(value => URL.canParse(value) && new URL(value).protocol === PARCEL_TRACKING.https).nullable().optional(),
};
