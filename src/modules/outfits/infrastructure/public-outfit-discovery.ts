import {and, eq, exists, isNull, or, sql, type AnyColumn, type SQL} from 'drizzle-orm';
import type {DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {brandProfiles, creatorProfiles, outfitItems, outfits, outfitTags, products, tags} from '../../../shared/infrastructure/database/schema';
import {PUBLIC_PROFILE} from '../../../shared/domain/public-profile.contract';
import {PRODUCT_STATUS} from '../../products/domain/product-contract';
import {OUTFIT_DISCOVERY, type PublicOutfitPage} from '../domain/public-outfit.contract';
import type {OutfitTag} from '../domain/outfit.types';

/** Applied together with publicOutfitVisibility, before ordering and pagination. */
export function publicOutfitDiscovery(database: DatabaseSession, input: PublicOutfitPage): SQL | undefined {
  const hasTag = (id: string | undefined, type: OutfitTag['type']) => id ? exists(database.db.select({id: tags.id}).from(outfitTags)
    .innerJoin(tags, eq(tags.id, outfitTags.tagId)).where(and(eq(outfitTags.outfitId, outfits.id), eq(tags.id, id), eq(tags.type, type)))) : undefined;
  const contains = (column: AnyColumn) => sql`position(lower(${input.q}) in lower(${column})) > ${OUTFIT_DISCOVERY.matchMinimum}`;
  const creator = () => exists(database.db.select({id: creatorProfiles.id}).from(creatorProfiles)
    .where(and(eq(creatorProfiles.id, outfits.creatorId), contains(creatorProfiles.displayName))));
  const brand = () => exists(database.db.select({id: brandProfiles.id}).from(brandProfiles)
    .where(and(eq(brandProfiles.id, outfits.brandId), contains(brandProfiles.brandName))));
  const product = (matchingName: boolean) => exists(database.db.select({id: products.id}).from(products)
    .innerJoin(brandProfiles, and(eq(brandProfiles.id, products.brandId), eq(brandProfiles.status, PUBLIC_PROFILE.status)))
    .where(and(eq(products.id, outfitItems.productId), eq(products.status, PRODUCT_STATUS.active),
      matchingName ? or(contains(products.name), contains(brandProfiles.brandName)) : undefined)));
  const pieces = (matchingName: boolean) => exists(database.db.select({id: outfitItems.id}).from(outfitItems)
    .where(and(eq(outfitItems.outfitId, outfits.id), input.itemType ? eq(outfitItems.itemType, input.itemType) : undefined,
      or(and(isNull(outfitItems.productId), matchingName ? contains(outfitItems.externalLabel) : undefined),
        and(eq(outfitItems.isShoppable, true), product(matchingName))))));
  let text: SQL | undefined;
  if (input.q) {
    switch (input.scope) {
      case OUTFIT_DISCOVERY.scope.creators: text = creator(); break;
      case OUTFIT_DISCOVERY.scope.pieces: text = pieces(true); break;
      default: text = or(contains(outfits.title), contains(outfits.description), creator(), brand(), pieces(true));
    }
  }
  return and(text, hasTag(input.styleId, OUTFIT_DISCOVERY.tag.style), hasTag(input.occasionId, OUTFIT_DISCOVERY.tag.occasion),
    input.itemType ? pieces(false) : undefined);
}
