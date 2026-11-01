import {PROFILE_STATUS} from './profile-editing.contract';

export const PUBLIC_PROFILE = {
  kind: {creator: 'creator', brand: 'brand'},
  status: PROFILE_STATUS.active,
  userStatus: 'active',
  first: 0,
} as const;
export type PublicProfileKind = (typeof PUBLIC_PROFILE.kind)[keyof typeof PUBLIC_PROFILE.kind];
