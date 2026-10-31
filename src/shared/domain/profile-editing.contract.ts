export const PROFILE_STATUS = {draft: 'draft', active: 'active', paused: 'paused', suspended: 'suspended'} as const;
export const PROFILE_STATUSES = [PROFILE_STATUS.draft, PROFILE_STATUS.active, PROFILE_STATUS.paused, PROFILE_STATUS.suspended] as const;
export const PROFILE_EDITING = {
  writableStatuses: [PROFILE_STATUS.active, PROFILE_STATUS.paused],
  limits: {nameMin: 2, creatorNameMax: 80, brandNameMax: 120, bioMin: 0, bioMax: 1000, handleMin: 1, handleMax: 120, firstRow: 0},
  url: {protocols: ['http', 'https'], require_protocol: true, require_tld: false},
  persistence: {lock: 'update', existsProjection: 1, memberActive: 'active'},
  failure: {changed: {code: 'profile_edit_unavailable', message: 'Profile access or status changed; refresh before editing'}},
} as const;

export type WritableProfileStatus = (typeof PROFILE_EDITING.writableStatuses)[number];
