import {PROFILE_STATUS, PROFILE_KIND} from './profile-editing.contract';

export const PUBLIC_PROFILE = {
  kind: PROFILE_KIND,
  status: PROFILE_STATUS.active,
  userStatus: 'active',
  first: 0,
} as const;
export type PublicProfileKind = (typeof PUBLIC_PROFILE.kind)[keyof typeof PUBLIC_PROFILE.kind];
