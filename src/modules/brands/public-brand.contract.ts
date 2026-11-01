export const PUBLIC_BRAND = {missing: 'Public brand not found'} as const;
export interface PublicBrandProfile {
  id: string; brandName: string; slug: string; bio: string | null; websiteUrl: string | null;
  stats: {publishedOutfits: number; activeProducts: number};
}
