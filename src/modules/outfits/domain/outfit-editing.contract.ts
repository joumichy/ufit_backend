import {PROFILE_EDITING, PROFILE_AUTHOR_ROLES} from '../../../shared/domain/profile-editing.contract';

export const OUTFIT_STATUS = {draft: 'draft', scheduled: 'scheduled', published: 'published', archived: 'archived'} as const;
export const OUTFIT_STATUSES = [OUTFIT_STATUS.draft, OUTFIT_STATUS.scheduled, OUTFIT_STATUS.published, OUTFIT_STATUS.archived] as const;
export const OUTFIT_VISIBILITY = {public: 'public', private: 'private', featured: 'featured'} as const;
export const OUTFIT_VISIBILITIES = [OUTFIT_VISIBILITY.public, OUTFIT_VISIBILITY.private, OUTFIT_VISIBILITY.featured] as const;
export const OUTFIT_ITEM_TYPES = [
  'top', 'bottom', 'shoes', 'bag', 'accessory', 'outerwear', 'eyewear',
  'headwear', 'shirt', 'knitwear', 'hoodie', 'vest', 'skirt', 'shorts',
  'dress', 'jumpsuit', 'swimwear', 'underwear', 'sneakers', 'boots', 'sandals',
  'heels', 'socks', 'tights', 'backpack', 'clutch', 'hat', 'beanie',
  'scarf', 'belt', 'gloves', 'watch', 'necklace', 'earrings', 'bracelet',
  'ring', 'tie', 'bowtie', 'hairclip', 'brooch', 'umbrella',
] as const;
export const OUTFIT_TAG_TYPES = ['style', 'occasion', 'season'] as const;
export const OUTFIT_ADMIN_ROLES = ['admin', 'super_admin'] as const;
export const OUTFIT_WRITE_ROLES = ['creator', 'brand_owner', 'brand_manager', ...OUTFIT_ADMIN_ROLES] as const;
export const OUTFIT_EDITING = {
  versionInitial: 1, versionStep: 1,
  limits: {titleMin: 2, titleMax: 120, descriptionMin: 0, descriptionMax: 6000, labelMin: 1, labelMax: 200, noteMax: 2000,
    pinCoordinateMax: 10000, pinsMax: 288, itemsMax: 24, imagesMax: 12, tagsMax: 24, integerMin: 0, integerMax: 2147483647, readyItems: 1, readyImages: 1,
    pageMin: 1, pageMax: 50, pageDefault: 20, overflow: 1, first: 0, last: -1},
  persistence: {lock: PROFILE_EDITING.persistence.lock},
  creation: {hash: 'sha256', encoding: 'hex'},
  labels: {unavailable: 'Article indisponible'},
  emptyImage: '',
  roles: PROFILE_AUTHOR_ROLES,
  failure: {
    owner: {code: 'outfit_owner_required', message: 'Exactly one creator or brand owner is required'},
    access: {code: 'outfit_owner_access_required', message: 'An active membership of an editable profile is required'},
    changed: {code: 'outfit_version_changed', message: 'The outfit changed; reload before editing'},
    state: {code: 'outfit_state_unavailable', message: 'This action is not available in the current outfit state'},
    request: {code: 'outfit_creation_request_changed', message: 'This creation request was used for another payload'},
    incomplete: {code: 'outfit_publication_incomplete', message: 'A description, photo and coherent outfit pieces are required'},
    items: {code: 'outfit_items_invalid', message: 'Use either an active product or a labelled inspiration piece, with distinct positions'},
    pins: {code: 'outfit_pins_invalid', message: 'Pins must identify distinct photo and item pairs with coordinates between 0 and 10000'},
    images: {code: 'outfit_images_invalid', message: 'Retained image identifiers must belong to this outfit, with distinct positions'},
    tags: {code: 'outfit_tags_invalid', message: 'Select distinct tags from the outfit tag registry'},
    missing: 'Outfit not found', page: 'Invalid managed outfit page',
  },
} as const;
