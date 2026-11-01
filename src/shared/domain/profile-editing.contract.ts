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


export const PROFILE_KIND = {creator: 'creator', brand: 'brand'} as const;
export type ProfileKind = (typeof PROFILE_KIND)[keyof typeof PROFILE_KIND];
export type ProfileOwner = {creatorId: string; brandId: null} | {creatorId: null; brandId: string};
export interface ProfileOwnerInfo {id: string; kind: ProfileKind; name: string; status: (typeof PROFILE_STATUSES)[number];}
export const PROFILE_AUTHOR_ROLES = {creator: 'creator', brandOwner: 'brand_owner', brandManager: 'brand_manager'} as const;
export function canAuthorProfile(roles: readonly string[], owner: ProfileOwner): boolean {
  return owner.creatorId !== null ? roles.includes(PROFILE_AUTHOR_ROLES.creator)
    : roles.includes(PROFILE_AUTHOR_ROLES.brandOwner) || roles.includes(PROFILE_AUTHOR_ROLES.brandManager);
}
