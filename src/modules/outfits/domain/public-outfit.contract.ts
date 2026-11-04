import type {OutfitItemType} from './outfit.types';
import {OUTFIT_STATUS, OUTFIT_VISIBILITY} from './outfit-editing.contract';
export const PUBLIC_OUTFIT = {
  status: OUTFIT_STATUS.published,
  visibility: {public: OUTFIT_VISIBILITY.public, featured: OUTFIT_VISIBILITY.featured},
  limits: {minimum: 1, maximum: 50, default: 20, overflow: 1, first: 0, last: -1},
  failure: {page: 'Invalid public outfit page', missing: 'Public outfit not found'},
} as const;
export const PUBLIC_OUTFIT_VISIBILITIES = [PUBLIC_OUTFIT.visibility.public, PUBLIC_OUTFIT.visibility.featured];
export const OUTFIT_DISCOVERY = {
  scope: {all: 'all', creators: 'creators', pieces: 'pieces'},
  tag: {style: 'style', occasion: 'occasion'},
  queryMax: 120, matchMinimum: 0,
} as const;
export const OUTFIT_SEARCH_SCOPES = [OUTFIT_DISCOVERY.scope.all, OUTFIT_DISCOVERY.scope.creators, OUTFIT_DISCOVERY.scope.pieces] as const;
export interface PublicOutfitPage {
  limit: number; cursor?: string; creatorId?: string; brandId?: string;
  /** Internal integration query; this filter is not accepted by the public HTTP schema. */
  productBrandId?: string;
  q?: string; scope?: (typeof OUTFIT_SEARCH_SCOPES)[number]; styleId?: string; occasionId?: string;
  itemType?: OutfitItemType;
}
