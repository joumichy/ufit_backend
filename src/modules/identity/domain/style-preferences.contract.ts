import {z} from 'zod';

export const STYLE_PREFERENCES = {
  route: {root: 'me/style-preferences', user: ':userId', parameter: 'userId', change: ':userId/changes/:requestId', request: 'requestId'},
  version: {absent: 0, initial: 1, step: 1, maximum: 2147483647},
  maximumStyles: 24, one: 1, tagType: 'style', lock: 'update',
  readableStatuses: ['active', 'onboarding'],
  digest: {algorithm: 'sha256', encoding: 'hex', pattern: '^[a-f0-9]{64}$'},
  failure: {
    invalid: {code: 'style_preferences_invalid', message: 'Invalid style preferences'},
    unavailable: {code: 'style_preferences_unavailable', message: 'Style preferences unavailable for this account'},
    changed: {code: 'style_preferences_changed', message: 'Style preferences changed; compare before saving'},
    request: {code: 'style_preferences_request_changed', message: 'This request already identifies another preference change'},
    tags: {code: 'style_preferences_tags_invalid', message: 'Select distinct styles from the canonical registry'},
  },
} as const;
const S = STYLE_PREFERENCES;
const identifier = z.uuid().transform(value => value.toLowerCase());
export const styleIDsSchema = z.array(identifier).max(S.maximumStyles).refine(ids => new Set(ids).size === ids.length).transform(ids => ids.sort());
export const stylePreferencesInputSchema = z.object({requestId: identifier,
  expectedVersion: z.number().int().min(S.version.absent).max(S.version.maximum - S.version.step), styleIds: styleIDsSchema}).strict();
export const stylePreferencesDocumentSchema = z.object({userId: identifier,
  version: z.number().int().min(S.version.absent).max(S.version.maximum), styleIds: styleIDsSchema, updatedAt: z.iso.datetime().nullable(),
}).strict().refine(value => (value.version === S.version.absent) === (value.updatedAt === null)
  && (value.version !== S.version.absent || value.styleIds.length === S.version.absent));
export const stylePreferencesReceiptSchema = z.object({requestId: identifier,
  version: z.number().int().min(S.version.initial).max(S.version.maximum)}).strict();
export type StylePreferencesDocument = z.infer<typeof stylePreferencesDocumentSchema>;
export type StylePreferencesReceipt = z.infer<typeof stylePreferencesReceiptSchema>;
export interface StylePreferenceChangeStatus {receipt: StylePreferencesReceipt | null; preferences: StylePreferencesDocument;}
