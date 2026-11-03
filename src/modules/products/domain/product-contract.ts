export const PRODUCT_STATUS = {draft: 'draft', active: 'active', archived: 'archived'} as const;
export const PRODUCT_STATUSES = [PRODUCT_STATUS.draft, PRODUCT_STATUS.active, PRODUCT_STATUS.archived] as const;
export const PRODUCT_VARIANT_STATUS = {active: 'active', outOfStock: 'out_of_stock', archived: 'archived'} as const;
export const PRODUCT_VARIANT_STATUSES = [PRODUCT_VARIANT_STATUS.active, PRODUCT_VARIANT_STATUS.outOfStock, PRODUCT_VARIANT_STATUS.archived] as const;
export const PRODUCT_IMAGE_KINDS = ['product', 'worn', 'detail', 'lookbook'] as const;
export const PRODUCT_ADMIN_ROLES = ['admin', 'super_admin'] as const;
export const PRODUCT_WRITE_ROLES = ['brand_owner', 'brand_manager', ...PRODUCT_ADMIN_ROLES] as const;
export const PRODUCT_EDITING = {
  versionInitial: 1, versionStep: 1,
  limits: {nameMin: 2, nameMax: 120, descriptionMin: 1, descriptionMax: 6000, categoryMin: 1, categoryMax: 100, detailMax: 2000, skuMin: 1, skuMax: 120, optionMax: 100, variantsMax: 100, imagesMax: 12, integerMin: 0, optionalTextMin: 0, integerMax: 2147483647, pageDefault: 20, pageMax: 50, pageMin: 1, pageOverflow: 1, lastIndex: -1, firstIndex: 0, readyVariants: 1, readyImages: 1},
  persistence: {lock: 'update', readIsolation: 'repeatable read', readAccess: 'read only', uniqueViolation: '23505', skuConstraint: 'product_variants_sku_unique'},
  creation: {hash: 'sha256', encoding: 'hex'},
  failure: {
    access: {code: 'product_brand_access_required', message: 'An active membership of a non-suspended brand is required'},
    changed: {code: 'product_version_changed', message: 'The product changed; reload before editing'},
    stockChanged: {code: 'product_stock_changed', message: 'Stock changed; reload before editing'},
    state: {code: 'product_state_unavailable', message: 'This action is not available in the current product state'},
    incomplete: {code: 'product_publication_incomplete', message: 'At least one active variant and one product image are required'},
    sku: {code: 'product_sku_unavailable', message: 'One of these SKUs is already in use'},
    images: {code: 'product_image_mismatch', message: 'Product image identifiers must belong to this product'},
    variants: {code: 'product_variant_mismatch', message: 'Preserve every existing variant identifier when editing'},
    request: {code: 'product_creation_request_changed', message: 'This creation request was already used for another payload'},
    missing: 'Product not found', invalidPage: 'Invalid product page',
  },
} as const;


export const PRODUCT_SELECTION = {
  roles: ['creator', ...PRODUCT_WRITE_ROLES],
  route: 'selection',
  searchMin: 1, searchMax: 120,
  failure: 'Invalid selectable product page',
} as const;
