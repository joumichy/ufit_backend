import {PROFILE_EDITING, PROFILE_AUTHOR_ROLES} from '../../../shared/domain/profile-editing.contract';

export const OUTFIT_STATUS = {draft: 'draft', submitted: 'submitted', underReview: 'under_review', published: 'published', rejected: 'rejected', archived: 'archived'} as const;
export const OUTFIT_STATUSES = [OUTFIT_STATUS.draft, OUTFIT_STATUS.submitted, OUTFIT_STATUS.underReview, OUTFIT_STATUS.published, OUTFIT_STATUS.rejected, OUTFIT_STATUS.archived] as const;
export const OUTFIT_VISIBILITY = {public: 'public', private: 'private', featured: 'featured'} as const;
export const OUTFIT_VISIBILITIES = [OUTFIT_VISIBILITY.public, OUTFIT_VISIBILITY.private, OUTFIT_VISIBILITY.featured] as const;
export const OUTFIT_ITEM_TYPES = ['top', 'bottom', 'shoes', 'bag', 'accessory', 'outerwear'] as const;
export const OUTFIT_TAG_TYPES = ['style', 'occasion', 'season'] as const;
export const OUTFIT_ADMIN_ROLES = ['admin', 'super_admin'] as const;
export const OUTFIT_WRITE_ROLES = ['creator', 'brand_owner', 'brand_manager', ...OUTFIT_ADMIN_ROLES] as const;
export const OUTFIT_EDITING = {
  versionInitial: 1, versionStep: 1,
  limits: {titleMin: 2, titleMax: 120, descriptionMin: 0, descriptionMax: 6000, labelMin: 1, labelMax: 200, noteMax: 2000,
    itemsMax: 24, imagesMax: 12, tagsMax: 24, integerMin: 0, integerMax: 2147483647, readyItems: 1, readyImages: 1,
    pageMin: 1, pageMax: 50, pageDefault: 20, overflow: 1, first: 0, last: -1},
  persistence: {lock: PROFILE_EDITING.persistence.lock},
  creation: {hash: 'sha256', encoding: 'hex'},
  emptyImage: '',
  roles: PROFILE_AUTHOR_ROLES,
  failure: {
    owner: {code: 'outfit_owner_required', message: 'Exactly one creator or brand owner is required'},
    access: {code: 'outfit_owner_access_required', message: 'An active membership of an editable profile is required'},
    changed: {code: 'outfit_version_changed', message: 'The outfit changed; reload before editing'},
    state: {code: 'outfit_state_unavailable', message: 'This action is not available in the current outfit state'},
    request: {code: 'outfit_creation_request_changed', message: 'This creation request was used for another payload'},
    incomplete: {code: 'outfit_submission_incomplete', message: 'A description, photo and coherent outfit pieces are required'},
    items: {code: 'outfit_items_invalid', message: 'Use either an active product or a labelled inspiration piece, with distinct positions'},
    images: {code: 'outfit_images_invalid', message: 'Retained image identifiers must belong to this outfit, with distinct positions'},
    tags: {code: 'outfit_tags_invalid', message: 'Select distinct tags from the outfit tag registry'},
    reason: {code: 'outfit_rejection_reason_required', message: 'A rejection reason is required'},
    missing: 'Outfit not found', page: 'Invalid managed outfit page',
  },
} as const;
