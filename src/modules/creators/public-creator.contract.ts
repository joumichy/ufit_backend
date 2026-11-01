import type {CreatorSocialPlatform} from './creator-social.contract';

export const PUBLIC_CREATOR = {root: 'public/creators', profile: ':id', id: 'id', missing: 'Public creator not found'} as const;
export interface PublicCreatorProfile {
  id: string; displayName: string; slug: string; bio: string | null; avatarUrl: string | null;
  grade: {code: string; label: string};
  socialAccounts: Array<{platform: CreatorSocialPlatform; handle: string; url: string | null}>;
  stats: {followers: number; publishedOutfits: number};
}
