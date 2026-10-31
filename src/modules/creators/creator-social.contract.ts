export const CREATOR_SOCIAL_PLATFORMS = ['instagram', 'tiktok', 'youtube', 'pinterest', 'website', 'other'] as const;
export type CreatorSocialPlatform = (typeof CREATOR_SOCIAL_PLATFORMS)[number];
export interface CreatorSocialAccountInput {platform: CreatorSocialPlatform; handle: string; url?: string | null;}
