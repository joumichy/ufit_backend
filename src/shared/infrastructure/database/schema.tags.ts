import {text, timestamp, uniqueIndex, uuid} from 'drizzle-orm/pg-core';
import {OUTFIT_TAG_TYPES} from '../../../modules/outfits/domain/outfit-editing.contract';
import {ufitSchema} from './schema-base';

export const tagTypeEnum = ufitSchema.enum('tag_type', OUTFIT_TAG_TYPES);
export const tags = ufitSchema.table('tags', {
  id: uuid('id').primaryKey().defaultRandom(), type: tagTypeEnum('type').notNull(),
  slug: text('slug').notNull(), label: text('label').notNull(),
  createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
}, table => ({
  typeSlugUnique: uniqueIndex('tags_type_slug_unique').on(table.type, table.slug),
  identityType: uniqueIndex('tags_identity_type_unique').on(table.id, table.type),
}));
