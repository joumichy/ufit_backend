import {APPLICATION} from '../../applications/types/application-contract';
import {PRODUCT_STATUS} from '../../products/domain/product-contract';
import {OUTFIT_STATUS} from '../../outfits/domain/outfit-editing.contract';

// These counts match the initial filters of the three moderation screens.
export const ADMIN_ACTIVITY = {
  route: 'activity',
  applicationStatuses: [APPLICATION.status.submitted, APPLICATION.status.underReview],
  productStatus: PRODUCT_STATUS.underReview,
  outfitStatus: OUTFIT_STATUS.underReview,
  minimumCount: 0,
  invalid: 'Invalid administration counters'
} as const;
export interface AdminActivity { applications: number; products: number; outfits: number; }
