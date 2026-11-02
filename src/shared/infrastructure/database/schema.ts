export {notificationPreferences} from './schema.notification-preferences';
export {accountDeletions,accountDeletionMedia} from './schema.account-deletions';
export {notificationInstallations,notificationDeviceAssociations,notificationInstallationRegistrations,notificationInstallationDetachments} from './schema.notification-installations';
import {users, userRoles} from './schema.identity';
export {users, userRoles, userStatusEnum, userRoleEnum, userAccessChanges} from './schema.identity';
export {notifications, notificationEmailDeliveries} from './schema.notifications';
import {CREATOR_GRADE} from '../../../modules/creators/grades/creator-grade.contract';
import {SHIPPING, SHIPMENT_STATUS} from '../../../modules/shipping/domain/shipping.contract';
import {PROFILE_IMAGE} from '../../../modules/media/domain/profile-image.contract';
import {OUTFIT_MEDIA} from '../../../modules/media/domain/outfit-media.contract';
import {BRAND_COMMERCE, COMMERCE_POLICY_KEY} from '../../../modules/brands/commerce-policy';
import {OUTFIT_EDITING, OUTFIT_STATUSES, OUTFIT_VISIBILITIES, OUTFIT_ITEM_TYPES, OUTFIT_TAG_TYPES} from '../../../modules/outfits/domain/outfit-editing.contract';
import { GENDER_TARGETS } from '../../domain/gender-target';
import { PRODUCT_MEDIA } from '../../../modules/media/domain/product-media.contract';
import { PRODUCT_EDITING, PRODUCT_STATUSES, PRODUCT_STATUS, PRODUCT_VARIANT_STATUSES, PRODUCT_IMAGE_KINDS } from '../../../modules/products/domain/product-contract';
import { PROFILE_STATUS, PROFILE_STATUSES } from '../../domain/profile-editing.contract';
import { CREATOR_SOCIAL_PLATFORMS } from '../../../modules/creators/creator-social.contract';
import type { CreatorApplicationDossier, BrandApplicationDossier } from "../../../modules/applications/types/application-contract";
import { sql } from 'drizzle-orm';
import { boolean, check, date, foreignKey, index, integer, jsonb, numeric, pgEnum, pgSchema, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import {ufitSchema,timestamps} from './schema-base';
export {ufitSchema} from './schema-base';
import {orders,orderItems} from './schema.orders';
export {orders,orderItems,orderStatusHistory,orderCancellations} from './schema.orders';
export {orderReturns,orderReturnItems,orderReturnRefunds,returnCommissionAdjustments} from './schema.returns';

export const schemaMigrations = ufitSchema.table('schema_migrations', {
  id: text('id').primaryKey(),
  checksum: text('checksum').notNull(),
  executedAt: timestamp('executed_at', { withTimezone: true }).notNull().defaultNow()
});

export const applicationStatusEnum = ufitSchema.enum('application_status', [
  'submitted',
  'under_review',
  'accepted',
  'rejected',
  'waitlisted',
  'needs_more_info'
]);

export const applicationDecisionEnum = ufitSchema.enum('application_decision', [
  'accept',
  'reject',
  'waitlist',
  'needs_more_info'
]);

export const profileStatusEnum = ufitSchema.enum('profile_status', PROFILE_STATUSES);

export const socialPlatformEnum = ufitSchema.enum('social_platform', CREATOR_SOCIAL_PLATFORMS);

export const brandMemberRoleEnum = ufitSchema.enum('brand_member_role', ['owner', 'manager']);

export const brandMemberStatusEnum = ufitSchema.enum('brand_member_status', ['active', 'invited', 'removed']);

export const creatorApplications = ufitSchema.table(
  'creator_applications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    displayName: text('display_name').notNull(),
    email: text('email').notNull(),
    portfolioUrl: text('portfolio_url'),
    dossier: jsonb('dossier').$type<CreatorApplicationDossier>(),
    version: integer('version').notNull().default(1),
    motivation: text('motivation').notNull(),
    audienceSummary: text('audience_summary'),
    status: applicationStatusEnum('status').notNull().default('submitted'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    queueIdx: index('creator_applications_queue_idx').on(table.status, table.submittedAt.desc(), table.id.desc()),
    userStatusIdx: index('idx_creator_applications_user_status').on(table.userId, table.status),
    activeUserUnique: uniqueIndex('uidx_creator_applications_active_user')
      .on(table.userId)
      .where(sql`${table.status} in ('submitted', 'under_review', 'waitlisted', 'needs_more_info')`)
  })
);

export const brandApplications = ufitSchema.table(
  'brand_applications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    brandName: text('brand_name').notNull(),
    email: text('email').notNull(),
    websiteUrl: text('website_url').notNull(),
    productCategory: text('product_category').notNull(),
    positioning: text('positioning').notNull(),
    dossier: jsonb('dossier').$type<BrandApplicationDossier>(),
    version: integer('version').notNull().default(1),
    status: applicationStatusEnum('status').notNull().default('submitted'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    queueIdx: index('brand_applications_queue_idx').on(table.status, table.submittedAt.desc(), table.id.desc()),
    userStatusIdx: index('idx_brand_applications_user_status').on(table.userId, table.status),
    activeUserUnique: uniqueIndex('uidx_brand_applications_active_user')
      .on(table.userId)
      .where(sql`${table.status} in ('submitted', 'under_review', 'waitlisted', 'needs_more_info')`)
  })
);

export const applicationReviews = ufitSchema.table(
  'application_reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    applicationType: text('application_type').notNull(),
    applicationId: uuid('application_id').notNull(),
    reviewerUserId: uuid('reviewer_user_id')
      .notNull()
      .references(() => users.id),
    decision: applicationDecisionEnum('decision').notNull(),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    applicationIdx: index('idx_application_reviews_application').on(table.applicationType, table.applicationId)
  })
);

export const creatorGrades = ufitSchema.table('creator_grades', {
  code: text('code').primaryKey(),
  label: text('label').notNull(),
  rank: integer('rank').notNull(),
  commissionBps: integer('commission_bps'),
  assignable: boolean('assignable').notNull().default(true),
  version: integer('version').notNull().default(CREATOR_GRADE.limits.initialVersion),
  updatedAt: timestamp('updated_at', {withTimezone: true}),
  criteria: jsonb('criteria').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

export const creatorProfiles = ufitSchema.table(
  'creator_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => creatorApplications.id),
    displayName: text('display_name').notNull(),
    slug: text('slug').notNull(),
    bio: text('bio'),
    avatarUrl: text('avatar_url'),
    imageVersion: integer('image_version').notNull().default(PROFILE_IMAGE.limits.initialVersion),
    status: profileStatusEnum('status').notNull().default(PROFILE_STATUS.active),
    gradeVersion: integer('grade_version').notNull().default(CREATOR_GRADE.limits.initialVersion),
    gradeCode: text('grade_code')
      .notNull()
      .default(CREATOR_GRADE.initialCode)
      .references(() => creatorGrades.code),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    userUnique: uniqueIndex('uidx_creator_profiles_user').on(table.userId),
    applicationUnique: uniqueIndex('uidx_creator_profiles_application').on(table.applicationId),
    slugUnique: uniqueIndex('uidx_creator_profiles_slug').on(table.slug),
    imageVersion: check('creator_profiles_image_version_check', sql`${table.imageVersion} >= ${PROFILE_IMAGE.limits.initialVersion}`)
  })
);

export const creatorSocialAccounts = ufitSchema.table(
  'creator_social_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    creatorProfileId: uuid('creator_profile_id')
      .notNull()
      .references(() => creatorProfiles.id),
    platform: socialPlatformEnum('platform').notNull(),
    handle: text('handle').notNull(),
    url: text('url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    creatorPlatformUnique: uniqueIndex('uidx_creator_social_accounts_creator_platform').on(
      table.creatorProfileId,
      table.platform
    )
  })
);

export const creatorGradeHistory = ufitSchema.table(
  'creator_grade_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    creatorProfileId: uuid('creator_profile_id')
      .notNull()
      .references(() => creatorProfiles.id),
    version: integer('version'),
    source: text('source', {enum: [CREATOR_GRADE.changeSource.application, CREATOR_GRADE.changeSource.administration]}),
    fromGradeLabel: text('from_grade_label'),
    toGradeLabel: text('to_grade_label'),
    fromGradeCode: text('from_grade_code').references(() => creatorGrades.code),
    toGradeCode: text('to_grade_code')
      .notNull()
      .references(() => creatorGrades.code),
    changedByUserId: uuid('changed_by_user_id').references(() => users.id),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    creatorIdx: index('idx_creator_grade_history_creator').on(table.creatorProfileId)
  })
);

export const creatorScoreSnapshots = ufitSchema.table(
  'creator_score_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    creatorProfileId: uuid('creator_profile_id')
      .notNull()
      .references(() => creatorProfiles.id),
    score: integer('score').notNull(),
    metrics: jsonb('metrics').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    creatorCapturedIdx: index('idx_creator_score_snapshots_creator_captured').on(table.creatorProfileId, table.capturedAt)
  })
);

export const brandProfiles = ufitSchema.table(
  'brand_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => brandApplications.id),
    brandName: text('brand_name').notNull(),
    logoUrl: text('logo_url'),
    imageVersion: integer('image_version').notNull().default(PROFILE_IMAGE.limits.initialVersion),
    slug: text('slug').notNull(),
    websiteUrl: text('website_url'),
    bio: text('bio'),
    status: profileStatusEnum('status').notNull().default(PROFILE_STATUS.active),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    ownerIdx: index('idx_brand_profiles_owner').on(table.ownerUserId),
    applicationUnique: uniqueIndex('uidx_brand_profiles_application').on(table.applicationId),
    slugUnique: uniqueIndex('uidx_brand_profiles_slug').on(table.slug),
    imageVersion: check('brand_profiles_image_version_check', sql`${table.imageVersion} >= ${PROFILE_IMAGE.limits.initialVersion}`)
  })
);

export const brandMembers = ufitSchema.table(
  'brand_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    brandProfileId: uuid('brand_profile_id')
      .notNull()
      .references(() => brandProfiles.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: brandMemberRoleEnum('role').notNull(),
    status: brandMemberStatusEnum('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    brandUserUnique: uniqueIndex('uidx_brand_members_brand_user').on(table.brandProfileId, table.userId),
    userIdx: index('idx_brand_members_user').on(table.userId, table.status)
  })
);

export const brandSettings = ufitSchema.table('brand_settings', {
  brandProfileId: uuid('brand_profile_id')
    .primaryKey()
    .references(() => brandProfiles.id),
  fulfillmentEmail: text('fulfillment_email'),
  returnPolicyUrl: text('return_policy_url'),
  autoApproveProducts: boolean('auto_approve_products').notNull().default(false),
  commercePolicyVersion: integer(BRAND_COMMERCE.persistence.versionColumn).notNull().default(BRAND_COMMERCE.revision.unconfigured),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, table => ({commercePolicyVersionValid: check(BRAND_COMMERCE.persistence.versionConstraint, sql`${table.commercePolicyVersion} >= ${BRAND_COMMERCE.revision.unconfigured}
  and ((${table.metadata} ? ${COMMERCE_POLICY_KEY}) = (${table.commercePolicyVersion} > ${BRAND_COMMERCE.revision.unconfigured}))`)}));


export const genderTargetEnum = ufitSchema.enum('gender_target', GENDER_TARGETS);
export const productStatusEnum = ufitSchema.enum('product_status', PRODUCT_STATUSES);
export const productVariantStatusEnum = ufitSchema.enum('product_variant_status', PRODUCT_VARIANT_STATUSES);
export const productImageKindEnum = ufitSchema.enum('product_image_kind', PRODUCT_IMAGE_KINDS);
export const outfitStatusEnum = ufitSchema.enum('outfit_status', OUTFIT_STATUSES);
export const outfitVisibilityEnum = ufitSchema.enum('outfit_visibility', OUTFIT_VISIBILITIES);
export const outfitItemTypeEnum = ufitSchema.enum('outfit_item_type', OUTFIT_ITEM_TYPES);
export const tagTypeEnum = ufitSchema.enum('tag_type', OUTFIT_TAG_TYPES);
export const editorialCollectionStatusEnum = ufitSchema.enum('editorial_collection_status', [
  'draft',
  'published',
  'archived'
]);
export const editorialItemTypeEnum = ufitSchema.enum('editorial_item_type', ['outfit', 'product']);
export const featuredSlotSurfaceEnum = ufitSchema.enum('featured_slot_surface', ['home', 'feed', 'collection']);
export const featuredSlotContentTypeEnum = ufitSchema.enum('featured_slot_content_type', ['outfit', 'product', 'collection']);



export const productCategories = ufitSchema.table(
  'product_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    parentId: uuid('parent_id'),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    position: integer('position').notNull().default(0),
    ...timestamps
  },
  (table) => ({
    slugUnique: uniqueIndex('product_categories_slug_unique').on(table.slug)
  })
);

export const products = ufitSchema.table(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    brandId: uuid('brand_id').notNull(),
    categoryId: uuid('category_id').references(() => productCategories.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description').notNull(),
    category: text('category').notNull(),
    genderTarget: genderTargetEnum('gender_target'),
    status: productStatusEnum('status').notNull().default(PRODUCT_STATUS.draft),
    version: integer('version').notNull().default(PRODUCT_EDITING.versionInitial),
    creationRequestId: uuid('creation_request_id'),
    creationFingerprint: text('creation_fingerprint'),
    basePrice: integer('base_price').notNull(),
    currency: text('currency').notNull().default('CHF'),
    material: text('material'),
    careInstructions: text('care_instructions'),
    commissionRateOverride: numeric('commission_rate_override', { precision: 5, scale: 4 }),
    reviewedBy: uuid('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    rejectionReason: text('rejection_reason'),
    ...timestamps
  },
  (table) => ({
    brandSlugUnique: uniqueIndex('products_brand_slug_unique').on(table.brandId, table.slug),
    creationRequestUnique: uniqueIndex('products_brand_creation_request_unique').on(table.brandId, table.creationRequestId),
    versionPositive: check('products_version_positive', sql`${table.version} >= ${PRODUCT_EDITING.versionInitial}`),
    creationRequestPair: check('products_creation_request_pair', sql`(${table.creationRequestId} is null) = (${table.creationFingerprint} is null)`),
    brandStatusIndex: index('products_brand_status_idx').on(table.brandId, table.status),
    statusIdIndex: index('products_status_id_idx').on(table.status, table.id)
  })
);

export const productVariants = ufitSchema.table(
  'product_variants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    size: text('size'),
    color: text('color'),
    sku: text('sku').notNull(),
    stockQuantity: integer('stock_quantity').notNull().default(0),
    priceOverride: integer('price_override'),
    status: productVariantStatusEnum('status').notNull().default('active'),
    ...timestamps
  },
  (table) => ({
    skuUnique: uniqueIndex('product_variants_sku_unique').on(table.sku),
    productIndex: index('product_variants_product_idx').on(table.productId)
  })
);

export const productImages = ufitSchema.table('product_images', {
  id: uuid('id').primaryKey().defaultRandom(),
  productId: uuid('product_id')
    .notNull()
    .references(() => products.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  position: integer('position').notNull().default(0),
  kind: productImageKindEnum('kind').notNull().default('product'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

export const outfits = ufitSchema.table(
  'outfits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    creatorId: uuid('creator_id'),
    brandId: uuid('brand_id'),
    version: integer('version').notNull().default(OUTFIT_EDITING.versionInitial),
    creationRequestId: uuid('creation_request_id'),
    creationFingerprint: text('creation_fingerprint'),
    title: text('title').notNull(),
    description: text('description').notNull(),
    coverImageUrl: text('cover_image_url').notNull(),
    status: outfitStatusEnum('status').notNull().default('draft'),
    visibility: outfitVisibilityEnum('visibility').notNull().default('private'),
    genderTarget: genderTargetEnum('gender_target'),
    totalPriceMin: integer('total_price_min').notNull().default(0),
    totalPriceMax: integer('total_price_max').notNull().default(0),
    reviewedBy: uuid('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    rejectionReason: text('rejection_reason'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    ...timestamps
  },
  (table) => ({
    versionPositive: check('outfits_version_positive', sql`${table.version} >= ${OUTFIT_EDITING.versionInitial}`),
    creationPair: check('outfits_creation_request_pair', sql`(${table.creationRequestId} is null) = (${table.creationFingerprint} is null)`),
    exclusiveOwner: check('outfits_owner_exclusive', sql`${table.creatorId} is null or ${table.brandId} is null`),
    creatorCreation: uniqueIndex('outfits_creator_creation_request_unique').on(table.creatorId, table.creationRequestId),
    brandCreation: uniqueIndex('outfits_brand_creation_request_unique').on(table.brandId, table.creationRequestId),
    statusIdIndex: index('outfits_status_id_idx').on(table.status, table.id),
    creatorIndex: index('outfits_creator_idx').on(table.creatorId),
    brandIndex: index('outfits_brand_idx').on(table.brandId)
  })
);

export const outfitItems = ufitSchema.table(
  'outfit_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    outfitId: uuid('outfit_id')
      .notNull()
      .references(() => outfits.id, { onDelete: 'cascade' }),
    productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),
    externalLabel: text('external_label'),
    itemType: outfitItemTypeEnum('item_type').notNull(),
    position: integer('position').notNull().default(0),
    isRequired: boolean('is_required').notNull().default(true),
    isShoppable: boolean('is_shoppable').notNull().default(false),
    stylingNote: text('styling_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    outfitPositionIndex: index('outfit_items_outfit_position_idx').on(table.outfitId, table.position),
    productIndex: index('outfit_items_product_idx').on(table.productId),
    outfitIdentity: uniqueIndex('outfit_items_outfit_id_unique').on(table.outfitId, table.id)
  })
);

export const outfitImages = ufitSchema.table('outfit_images', {
  id: uuid('id').primaryKey().defaultRandom(),
  outfitId: uuid('outfit_id')
    .notNull()
    .references(() => outfits.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  position: integer('position').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => ({urlIndex: index('outfit_images_url_idx').on(table.url),
  outfitIdentity: uniqueIndex('outfit_images_outfit_id_unique').on(table.outfitId, table.id)}));

export const outfitPins = ufitSchema.table('outfit_pins', {
  outfitId: uuid('outfit_id').notNull().references(() => outfits.id, {onDelete: 'cascade'}),
  imageId: uuid('image_id').notNull(), itemId: uuid('item_id').notNull(),
  x: integer('x').notNull(), y: integer('y').notNull()
}, table => ({
  pair: uniqueIndex('outfit_pins_pair_unique').on(table.imageId, table.itemId),
  image: foreignKey({columns: [table.outfitId, table.imageId], foreignColumns: [outfitImages.outfitId, outfitImages.id]}).onDelete('cascade'),
  item: foreignKey({columns: [table.outfitId, table.itemId], foreignColumns: [outfitItems.outfitId, outfitItems.id]}).onDelete('cascade'),
  xRange: check('outfit_pins_x_range', sql`${table.x} between ${OUTFIT_EDITING.limits.integerMin} and ${OUTFIT_EDITING.limits.pinCoordinateMax}`),
  yRange: check('outfit_pins_y_range', sql`${table.y} between ${OUTFIT_EDITING.limits.integerMin} and ${OUTFIT_EDITING.limits.pinCoordinateMax}`)
}));

export const tags = ufitSchema.table(
  'tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: tagTypeEnum('type').notNull(),
    slug: text('slug').notNull(),
    label: text('label').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    typeSlugUnique: uniqueIndex('tags_type_slug_unique').on(table.type, table.slug)
  })
);

export const outfitTags = ufitSchema.table(
  'outfit_tags',
  {
    outfitId: uuid('outfit_id')
      .notNull()
      .references(() => outfits.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' })
  },
  (table) => ({
    outfitTagUnique: uniqueIndex('outfit_tags_unique').on(table.outfitId, table.tagId)
  })
);

export const editorialCollections = ufitSchema.table('editorial_collections', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  subtitle: text('subtitle'),
  description: text('description').notNull(),
  coverImageUrl: text('cover_image_url'),
  status: editorialCollectionStatusEnum('status').notNull().default('draft'),
  createdBy: uuid('created_by').notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  ...timestamps
});

export const editorialCollectionItems = ufitSchema.table(
  'editorial_collection_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => editorialCollections.id, { onDelete: 'cascade' }),
    itemType: editorialItemTypeEnum('item_type').notNull(),
    outfitId: uuid('outfit_id').references(() => outfits.id, { onDelete: 'cascade' }),
    productId: uuid('product_id').references(() => products.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    collectionPositionIndex: index('editorial_collection_items_collection_position_idx').on(table.collectionId, table.position)
  })
);

export const featuredSlots = ufitSchema.table(
  'featured_slots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    surface: featuredSlotSurfaceEnum('surface').notNull(),
    slotKey: text('slot_key').notNull(),
    contentType: featuredSlotContentTypeEnum('content_type').notNull(),
    outfitId: uuid('outfit_id').references(() => outfits.id, { onDelete: 'cascade' }),
    productId: uuid('product_id').references(() => products.id, { onDelete: 'cascade' }),
    collectionId: uuid('collection_id').references(() => editorialCollections.id, { onDelete: 'cascade' }),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    surfaceSlotUnique: uniqueIndex('featured_slots_surface_slot_unique').on(table.surface, table.slotKey)
  })
);


export const savedOutfits = ufitSchema.table(
  'saved_outfits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    outfitId: uuid('outfit_id')
      .notNull()
      .references(() => outfits.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    userOutfitUnique: uniqueIndex('saved_outfits_user_outfit_unique').on(table.userId, table.outfitId),
    userIdIndex: index('saved_outfits_user_id_idx').on(table.userId)
  })
);

export const creatorFollows = ufitSchema.table(
  'creator_follows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    creatorId: uuid('creator_id')
      .notNull()
      .references(() => creatorProfiles.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    userCreatorUnique: uniqueIndex('creator_follows_user_creator_unique').on(table.userId, table.creatorId),
    userIdIndex: index('creator_follows_user_id_idx').on(table.userId)
  })
);

export const carts = ufitSchema.table(
  'carts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('active'),
    brandId: uuid('brand_id'),
    sourceOutfitId: uuid('source_outfit_id').references(() => outfits.id, { onDelete: 'set null' }),
    sourceCreatorId: uuid('source_creator_id').references(() => creatorProfiles.id, { onDelete: 'set null' }),
    currency: text('currency').notNull().default('CHF'),
    subtotalAmount: integer('subtotal_amount').notNull().default(0),
    ...timestamps
  },
  (table) => ({
    userStatusIndex: index('carts_user_status_idx').on(table.userId, table.status)
  })
);

export const cartItems = ufitSchema.table(
  'cart_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cartId: uuid('cart_id')
      .notNull()
      .references(() => carts.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    productVariantId: uuid('product_variant_id')
      .notNull()
      .references(() => productVariants.id),
    quantity: integer('quantity').notNull(),
    unitPrice: integer('unit_price').notNull(),
    currency: text('currency').notNull().default('CHF'),
    brandId: uuid('brand_id').notNull(),
    sourceOutfitId: uuid('source_outfit_id').references(() => outfits.id, { onDelete: 'set null' }),
    sourceCreatorId: uuid('source_creator_id').references(() => creatorProfiles.id, { onDelete: 'set null' }),
    ...timestamps
  },
  (table) => ({
    cartVariantOutfitUnique: uniqueIndex('cart_items_cart_variant_outfit_unique').on(
      table.cartId,
      table.productVariantId,
      table.sourceOutfitId
    ),
    cartIdIndex: index('cart_items_cart_id_idx').on(table.cartId)
  })
);

export const payments = ufitSchema.table(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull().default('placeholder'),
    providerPaymentIntentId: text('provider_payment_intent_id'),
    status: text('status').notNull().default('disabled'),
    amount: integer('amount').notNull(),
    currency: text('currency').notNull().default('CHF'),
    ...timestamps
  },
  (table) => ({
    orderIdIndex: index('payments_order_id_idx').on(table.orderId),
    providerIntentUnique: uniqueIndex('payments_provider_intent_unique')
      .on(table.provider, table.providerPaymentIntentId)
      .where(sql`${table.providerPaymentIntentId} is not null`)
  })
);

export const stripeWebhookEvents = ufitSchema.table(
  'stripe_webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    stripeEventId: text('stripe_event_id').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    stripeEventIdUnique: uniqueIndex('stripe_webhook_events_stripe_event_id_unique').on(table.stripeEventId),
    typeIndex: index('stripe_webhook_events_type_idx').on(table.type)
  })
);

export {commissionRules} from './schema.commissions';

export const commissions = ufitSchema.table(
  'commissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderItemId: uuid('order_item_id')
      .notNull()
      .references(() => orderItems.id, { onDelete: 'cascade' }),
    creatorId: uuid('creator_id')
      .notNull()
      .references(() => creatorProfiles.id),
    brandId: uuid('brand_id').notNull(),
    sourceOutfitId: uuid('source_outfit_id')
      .notNull()
      .references(() => outfits.id),
    baseAmount: integer('base_amount').notNull(),
    commissionRate: numeric('commission_rate', { precision: 5, scale: 4 }).notNull(),
    commissionAmount: integer('commission_amount').notNull(),
    status: text('status').notNull().default('estimated'),
    validationDate: timestamp('validation_date', { withTimezone: true }),
    ...timestamps
  },
  (table) => ({
    creatorStatusIndex: index('commissions_creator_status_idx').on(table.creatorId, table.status),
    orderItemIdIndex: index('commissions_order_item_id_idx').on(table.orderItemId)
  })
);

export const commissionEvents = ufitSchema.table('commission_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  commissionId: uuid('commission_id')
    .notNull()
    .references(() => commissions.id, { onDelete: 'cascade' }),
  eventType: text('event_type').notNull(),
  fromStatus: text('from_status'),
  toStatus: text('to_status'),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

export const creatorPayouts = ufitSchema.table('creator_payouts', {
  id: uuid('id').primaryKey().defaultRandom(),
  creatorId: uuid('creator_id')
    .notNull()
    .references(() => creatorProfiles.id),
  status: text('status').notNull().default('pending'),
  amount: integer('amount').notNull(),
  currency: text('currency').notNull().default('CHF'),
  periodStart: date('period_start').notNull(),
  periodEnd: date('period_end').notNull(),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

export const shipments = ufitSchema.table(
  'shipments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' })
      .unique(),
    brandId: uuid('brand_id').notNull(),
    status: text('status').notNull().default(SHIPMENT_STATUS.pending),
    version: integer('version').notNull().default(SHIPPING.revision.initial),
    incidentReason: text('incident_reason'),
    incidentAt: timestamp('incident_at', { withTimezone: true }),
    carrier: text('carrier'),
    trackingNumber: text('tracking_number'),
    trackingUrl: text('tracking_url'),
    labelUrl: text('label_url'),
    shippedAt: timestamp('shipped_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    ...timestamps
  },
  (table) => ({
    brandStatusIndex: index('shipments_brand_status_idx').on(table.brandId, table.status),
    knownStatus: check(SHIPPING.constraint.status, sql`${table.status} in (${SHIPMENT_STATUS.pending}, ${SHIPMENT_STATUS.preparing}, ${SHIPMENT_STATUS.shipped}, ${SHIPMENT_STATUS.delivered}, ${SHIPMENT_STATUS.failed}, ${SHIPMENT_STATUS.cancelled})`),
    versionPositive: check(SHIPPING.constraint.version, sql`${table.version} >= ${SHIPPING.revision.initial}`),
    incidentConsistent: check(SHIPPING.constraint.incident, sql`(${table.incidentReason} is null) = (${table.incidentAt} is null)
      and (${table.incidentReason} is null or char_length(btrim(${table.incidentReason})) between ${SHIPPING.limit.minimumText} and ${SHIPPING.limit.incident})
      and (${table.status} <> ${SHIPMENT_STATUS.failed} or ${table.incidentReason} is not null)`)
  })
);

export const shipmentEvents = ufitSchema.table('shipment_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  shipmentId: uuid('shipment_id')
    .notNull()
    .references(() => shipments.id, { onDelete: 'cascade' }),
  fromStatus: text('from_status'),
  toStatus: text('to_status').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

export const adminActionLogs = ufitSchema.table(
  'admin_action_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    adminUserId: uuid('admin_user_id')
      .notNull()
      .references(() => users.id),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    targetIndex: index('admin_action_logs_target_idx').on(table.targetType, table.targetId)
  })
);

export type { UserRow, NewUserRow, UserRoleRow, NewUserRoleRow, CreatorApplicationRow, NewCreatorApplicationRow, BrandApplicationRow, NewBrandApplicationRow, ApplicationReviewRow, NewApplicationReviewRow, CreatorProfileRow, NewCreatorProfileRow, BrandProfileRow, NewBrandProfileRow, BrandMemberRow, NewBrandMemberRow, ProductRow, NewProductRow, ProductVariantRow, NewProductVariantRow, ProductImageRow, NewProductImageRow, OutfitRow, NewOutfitRow, OutfitItemRow, NewOutfitItemRow, OutfitImageRow, NewOutfitImageRow, EditorialCollectionRow, NewEditorialCollectionRow, EditorialCollectionItemRow, NewEditorialCollectionItemRow, SavedOutfitRow, CreatorFollowRow, CartRow, NewCartRow, CartItemRow, NewCartItemRow, OrderRow, NewOrderRow, OrderItemRow, NewOrderItemRow, PaymentRow, StripeWebhookEventRow, NewStripeWebhookEventRow, CommissionRow, NewCommissionRow, ShipmentRow, NewShipmentRow, AdminActionLogRow } from './schema.rows';

export { connectAccounts } from "./schema.connect";

export const productMediaAssets = ufitSchema.table('product_media_assets', {
  id: uuid('id').primaryKey(),
  brandId: uuid('brand_id').notNull().references(() => brandProfiles.id),
  uploadedBy: uuid('uploaded_by').notNull().references(() => users.id),
  requestId: uuid('request_id').notNull(),
  fingerprint: text('fingerprint').notNull(),
  byteSize: integer('byte_size').notNull(),
  contentType: text('content_type').notNull(),
  objectPath: text('object_path').notNull(),
  status: text('status', {enum: PRODUCT_MEDIA.statuses}).notNull().default(PRODUCT_MEDIA.status.pending),
  ...timestamps,
}, table => ({
  requestUnique: uniqueIndex('product_media_brand_request_unique').on(table.brandId, table.requestId),
  pathUnique: uniqueIndex('product_media_object_path_unique').on(table.objectPath),
  sizeCheck: check('product_media_size_valid', sql`${table.byteSize} > 0 and ${table.byteSize} <= ${sql.raw(String(PRODUCT_MEDIA.maxBytes))}`),
  typeCheck: check('product_media_mime_valid', sql`${table.contentType} = ${sql.raw("'" + PRODUCT_MEDIA.mime + "'")}`),
  hashCheck: check('product_media_fingerprint_valid', sql`${table.fingerprint} ~ ${sql.raw("'" + PRODUCT_MEDIA.hash.pattern + "'")}`),
  statusCheck: check('product_media_status_valid', sql`${table.status} in (${sql.raw(PRODUCT_MEDIA.statuses.map(value=>`'${value}'`).join(', '))})`),
}));

export const outfitMediaAssets = ufitSchema.table('outfit_media_assets', {
  id: uuid('id').primaryKey(),
  creatorId: uuid('creator_id').references(() => creatorProfiles.id), brandId: uuid('brand_id').references(() => brandProfiles.id),
  uploadedBy: uuid('uploaded_by').notNull().references(() => users.id), requestId: uuid('request_id').notNull(),
  fingerprint: text('fingerprint').notNull(), byteSize: integer('byte_size').notNull(), contentType: text('content_type').notNull(),
  objectPath: text('object_path').notNull(), status: text('status', {enum: OUTFIT_MEDIA.statuses}).notNull().default(OUTFIT_MEDIA.status.pending),
  ...timestamps,
}, table => ({
  ownerCheck: check('outfit_media_owner_required', sql`(${table.creatorId} is not null) <> (${table.brandId} is not null)`),
  creatorRequest: uniqueIndex('outfit_media_creator_request_unique').on(table.creatorId, table.requestId),
  brandRequest: uniqueIndex('outfit_media_brand_request_unique').on(table.brandId, table.requestId),
  pathUnique: uniqueIndex('outfit_media_object_path_unique').on(table.objectPath),
  sizeCheck: check('outfit_media_size_valid', sql`${table.byteSize} > 0 and ${table.byteSize} <= ${sql.raw(String(OUTFIT_MEDIA.maxBytes))}`),
  typeCheck: check('outfit_media_mime_valid', sql`${table.contentType} = ${sql.raw("'" + OUTFIT_MEDIA.mime + "'")}`),
  hashCheck: check('outfit_media_fingerprint_valid', sql`${table.fingerprint} ~ ${sql.raw("'" + OUTFIT_MEDIA.hash.pattern + "'")}`),
  statusCheck: check('outfit_media_status_valid', sql`${table.status} in (${sql.raw(OUTFIT_MEDIA.statuses.map(value=>`'${value}'`).join(', '))})`),
}));

export {creatorGradeRevisions} from './schema.creator-grades';

export * from './schema.notification-push';

export {profileMediaAssets,profileImageChanges} from './schema.profile-media';
