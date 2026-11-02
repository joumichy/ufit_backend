import {check,integer,text,timestamp,uniqueIndex,uuid} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import {ufitSchema,timestamps} from './schema-base';
import {users} from './schema.identity';
import {creatorProfiles,brandProfiles} from './schema';
import {PROFILE_IMAGE as P} from '../../../modules/media/domain/profile-image.contract';
import {IMAGE_UPLOAD,MEDIA_ASSET_STATUSES} from '../../../modules/media/domain/image-upload.contract';
const ownerColumns=()=>({
  userId:uuid('user_id').references(()=>users.id),creatorId:uuid('creator_id').references(()=>creatorProfiles.id),
  brandId:uuid('brand_id').references(()=>brandProfiles.id),
});
export const profileMediaAssets=ufitSchema.table('profile_media_assets',{
  id:uuid('id').primaryKey(),...ownerColumns(),uploadedBy:uuid('uploaded_by').notNull().references(()=>users.id),
  requestId:uuid('request_id').notNull(),fingerprint:text('fingerprint').notNull(),byteSize:integer('byte_size').notNull(),
  contentType:text('content_type').notNull(),objectPath:text('object_path').notNull(),
  status:text('status',{enum:MEDIA_ASSET_STATUSES}).notNull().default(P.status.pending),...timestamps,
},t=>({
  request:uniqueIndex('profile_media_request_unique').on(t.requestId),path:uniqueIndex('profile_media_path_unique').on(t.objectPath),
  owner:check('profile_media_owner_required',sql`num_nonnulls(${t.userId},${t.creatorId},${t.brandId})=${P.limits.one}`),
  size:check('profile_media_size_valid',sql`${t.byteSize}>${P.limits.zero} and ${t.byteSize}<=${P.maxBytes}`),
  mime:check('profile_media_mime_valid',sql`${t.contentType}=${sql.raw(`'${P.mime}'`)}`),
  hash:check('profile_media_fingerprint_valid',sql`${t.fingerprint}~${sql.raw(`'${IMAGE_UPLOAD.hash.pattern}'`)}`),
  status:check('profile_media_status_valid',sql`${t.status} in (${sql.raw(MEDIA_ASSET_STATUSES.map(s=>`'${s}'`).join(', '))})`),
}));
export const profileImageChanges=ufitSchema.table('profile_image_changes',{
  requestId:uuid('request_id').primaryKey(),...ownerColumns(),changedBy:uuid('changed_by').notNull().references(()=>users.id),
  expectedVersion:integer('expected_version').notNull(),version:integer('version').notNull(),
  assetId:uuid('asset_id'),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},t=>({
  owner:check('profile_image_change_owner_required',sql`num_nonnulls(${t.userId},${t.creatorId},${t.brandId})=${P.limits.one}`),
  version:check('profile_image_change_version_valid',sql`${t.expectedVersion}>=${P.limits.initialVersion} and ${t.expectedVersion}<${P.limits.maxVersion} and ${t.version}=${t.expectedVersion}+${P.limits.one}`),
}));
