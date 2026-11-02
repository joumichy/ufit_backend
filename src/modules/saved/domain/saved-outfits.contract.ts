import {BadRequestException} from '@nestjs/common';
import {z} from 'zod';

export const SAVED_OUTFITS = {
  repository: 'SavedRepository',
  page: {minimum: 1, maximum: 50, default: 20, overflow: 1, first: 0, last: -1, decimal: /^\d+$/},
  cursor: {encoding: 'base64url', timestamp: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/, millisecondsEnd: 23, utc: 'Z', maximumLength: 256},
  query: {separator: ','},
  routes: {collection: 'saved-outfits', states: 'saved-outfits/states', outfit: 'saved-outfits/:outfitId', id: 'outfitId'},
  failure: {page: 'Invalid saved outfit page', states: 'Invalid saved outfit identities', missing: 'Public outfit not found'},
} as const;

const savedTimestamp = z.string().regex(SAVED_OUTFITS.cursor.timestamp).refine(value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value.slice(SAVED_OUTFITS.page.first, SAVED_OUTFITS.cursor.millisecondsEnd) + SAVED_OUTFITS.cursor.utc;
});
export const savedOutfitReferenceSchema = z.object({id: z.uuid().transform(value => value.toLowerCase()), savedAt: savedTimestamp}).strict();
export type SavedOutfitReference = z.infer<typeof savedOutfitReferenceSchema>;
export interface SavedOutfitQuery {limit: number; cursor?: SavedOutfitReference}
export interface SavedOutfitPage {items: SavedOutfitReference[]; nextCursor: string | null}

const pageSchema = z.object({
  limit: z.union([z.number(), z.string().regex(SAVED_OUTFITS.page.decimal)]).transform(value => Number(value)).pipe(z.number().int()
    .min(SAVED_OUTFITS.page.minimum).max(SAVED_OUTFITS.page.maximum)).default(SAVED_OUTFITS.page.default),
  cursor: z.string().min(SAVED_OUTFITS.page.minimum).max(SAVED_OUTFITS.cursor.maximumLength).optional(),
}).strict();
const statesSchema = z.object({ids: z.string().transform(value => value.split(SAVED_OUTFITS.query.separator))
  .pipe(z.array(z.uuid()).min(SAVED_OUTFITS.page.minimum).max(SAVED_OUTFITS.page.maximum))
  .refine(ids => new Set(ids.map(id => id.toLowerCase())).size === ids.length)}).strict();

export function savedOutfitCursor(reference: SavedOutfitReference): string {
  return Buffer.from(JSON.stringify(savedOutfitReferenceSchema.parse(reference))).toString(SAVED_OUTFITS.cursor.encoding);
}
export function savedOutfitQuery(input: unknown): SavedOutfitQuery {
  const parsed = pageSchema.safeParse(input);
  if (!parsed.success) throw new BadRequestException(SAVED_OUTFITS.failure.page);
  const {limit, cursor} = parsed.data;
  if (cursor === undefined) return {limit};
  try {
    const bytes = Buffer.from(cursor, SAVED_OUTFITS.cursor.encoding);
    if (bytes.toString(SAVED_OUTFITS.cursor.encoding) !== cursor) throw new Error(SAVED_OUTFITS.failure.page);
    const reference = savedOutfitReferenceSchema.parse(JSON.parse(bytes.toString()));
    if (savedOutfitCursor(reference) !== cursor) throw new Error(SAVED_OUTFITS.failure.page);
    return {limit, cursor: reference};
  } catch { throw new BadRequestException(SAVED_OUTFITS.failure.page); }
}
export function savedOutfitIdentities(input: unknown): string[] {
  const parsed = statesSchema.safeParse(input);
  if (!parsed.success) throw new BadRequestException(SAVED_OUTFITS.failure.states);
  return parsed.data.ids.map(id => id.toLowerCase());
}
