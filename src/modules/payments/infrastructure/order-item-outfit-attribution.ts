import {inArray} from 'drizzle-orm';
import type {DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {orderItems, outfits} from '../../../shared/infrastructure/database/schema';

type OrderItemSource = Pick<typeof orderItems.$inferSelect, 'sourceCreatorId' | 'sourceOutfitId'>;

/** A source without a creator is a brand publication only when its recorded owner matches the order. */
export async function hasValidNonCreatorOutfitSources(database: DatabaseSession, brandId: string,
  items: readonly OrderItemSource[]): Promise<boolean> {
  const sourceIds = [...new Set(items.filter(item => item.sourceCreatorId === null)
    .flatMap(item => item.sourceOutfitId === null ? [] : [item.sourceOutfitId]))];
  if (!sourceIds.length) return true;
  // Publication status may change after purchase; ownership, rather than visibility, establishes this source.
  const sources = await database.db.select({id: outfits.id, creatorId: outfits.creatorId, brandId: outfits.brandId})
    .from(outfits).where(inArray(outfits.id, sourceIds));
  return sourceIds.every(id => sources.some(source => source.id === id && source.creatorId === null && source.brandId === brandId));
}
