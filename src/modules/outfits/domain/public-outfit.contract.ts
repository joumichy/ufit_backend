import {OUTFIT_STATUS, OUTFIT_VISIBILITY} from './outfit-editing.contract';
export const PUBLIC_OUTFIT = {
  status: OUTFIT_STATUS.published,
  visibility: {public: OUTFIT_VISIBILITY.public, featured: OUTFIT_VISIBILITY.featured},
  limits: {minimum: 1, maximum: 50, default: 20, overflow: 1, first: 0, last: -1},
  failure: {page: 'Invalid public outfit page', missing: 'Public outfit not found'},
} as const;
export const PUBLIC_OUTFIT_VISIBILITIES = [PUBLIC_OUTFIT.visibility.public, PUBLIC_OUTFIT.visibility.featured];
export interface PublicOutfitPage {limit: number; cursor?: string; creatorId?: string; brandId?: string;}
