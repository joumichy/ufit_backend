import {and, eq, exists, inArray, isNotNull, isNull, or} from 'drizzle-orm';
import type {DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {brandProfiles, creatorProfiles, outfits, users} from '../../../shared/infrastructure/database/schema';
import {PUBLIC_PROFILE} from '../../../shared/domain/public-profile.contract';
import {PUBLIC_OUTFIT, PUBLIC_OUTFIT_VISIBILITIES} from '../domain/public-outfit.contract';

/** Feed, saved references and saved states must agree on public visibility. */
export function publicOutfitVisibility(database: DatabaseSession) {
  const creator = database.db.select({id: creatorProfiles.id}).from(creatorProfiles).innerJoin(users, eq(users.id, creatorProfiles.userId))
    .where(and(eq(creatorProfiles.id, outfits.creatorId), eq(creatorProfiles.status, PUBLIC_PROFILE.status), eq(users.status, PUBLIC_PROFILE.userStatus)));
  const brand = database.db.select({id: brandProfiles.id}).from(brandProfiles)
    .where(and(eq(brandProfiles.id, outfits.brandId), eq(brandProfiles.status, PUBLIC_PROFILE.status)));
  return and(eq(outfits.status, PUBLIC_OUTFIT.status), inArray(outfits.visibility, PUBLIC_OUTFIT_VISIBILITIES),
    or(and(isNull(outfits.creatorId), isNull(outfits.brandId)),
      and(isNotNull(outfits.creatorId), isNull(outfits.brandId), exists(creator)),
      and(isNull(outfits.creatorId), isNotNull(outfits.brandId), exists(brand))));
}
