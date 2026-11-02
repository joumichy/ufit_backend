import {ConflictException, ForbiddenException, Inject, Injectable, ServiceUnavailableException} from '@nestjs/common';
import {and, eq, exists, inArray, isNull, ne, or} from 'drizzle-orm';
import type {ProfileOwner} from '../../../shared/domain/profile-editing.contract';
import {PUBLIC_PROFILE} from '../../../shared/domain/public-profile.contract';
import {DatabaseService} from '../../../shared/infrastructure/database/database.service';
import type {DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {findAuthoringProfile, ProfileAccessMode} from '../../../shared/infrastructure/database/profile-authoring-access';
import {brandProfiles, creatorProfiles, users, outfitImages, outfits, outfitMediaAssets} from '../../../shared/infrastructure/database/schema';
import {PUBLIC_OUTFIT, PUBLIC_OUTFIT_VISIBILITIES} from '../../outfits/domain/public-outfit.contract';
import {OUTFIT_MEDIA} from '../domain/outfit-media.contract';
import type {OutfitMediaAsset, OutfitMediaRepository, OutfitMediaReservation} from '../domain/outfit-media.types';

type AssetRow = typeof outfitMediaAssets.$inferSelect;
@Injectable()
export class DrizzleOutfitMediaRepository implements OutfitMediaRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseSession) {}
  private ownerCondition(owner: ProfileOwner) {
    return and(owner.creatorId !== null ? eq(outfitMediaAssets.creatorId, owner.creatorId) : isNull(outfitMediaAssets.creatorId),
      owner.brandId !== null ? eq(outfitMediaAssets.brandId, owner.brandId) : isNull(outfitMediaAssets.brandId));
  }
  private asset(row: AssetRow): OutfitMediaAsset {
    if (row.creatorId !== null && row.brandId === null) return {...row, creatorId: row.creatorId, brandId: null};
    if (row.brandId !== null && row.creatorId === null) return {...row, creatorId: null, brandId: row.brandId};
    throw new ServiceUnavailableException(OUTFIT_MEDIA.failure.unavailable);
  }
  async reserve(input: OutfitMediaReservation): Promise<OutfitMediaAsset> {
    return this.database.db.transaction(async tx => {
      if (!await findAuthoringProfile({db: tx}, input, input.uploadedBy, ProfileAccessMode.Lock)) throw new ForbiddenException(OUTFIT_MEDIA.failure.access);
      const [existing] = await tx.select().from(outfitMediaAssets).where(and(this.ownerCondition(input), eq(outfitMediaAssets.requestId, input.requestId)));
      if (existing) {
        if (existing.status===OUTFIT_MEDIA.status.retired) throw new ConflictException(OUTFIT_MEDIA.failure.ownership);
        if (existing.fingerprint !== input.fingerprint || existing.byteSize !== input.byteSize || existing.contentType !== input.contentType) throw new ConflictException(OUTFIT_MEDIA.failure.request);
        return this.asset(existing);
      }
      const [row] = await tx.insert(outfitMediaAssets).values(input).returning(); return this.asset(row);
    });
  }
  async markReady(asset: OutfitMediaAsset, userId: string): Promise<OutfitMediaAsset> {
    return this.database.db.transaction(async tx => {
      if (!await findAuthoringProfile({db: tx}, asset, userId, ProfileAccessMode.Lock)) throw new ForbiddenException(OUTFIT_MEDIA.failure.access);
      const [row] = await tx.update(outfitMediaAssets).set({status: OUTFIT_MEDIA.status.ready, updatedAt: new Date()})
        .where(and(eq(outfitMediaAssets.id, asset.id), this.ownerCondition(asset), eq(outfitMediaAssets.fingerprint, asset.fingerprint),ne(outfitMediaAssets.status,OUTFIT_MEDIA.status.retired))).returning();
      if (!row) throw new ConflictException(OUTFIT_MEDIA.failure.request);
      return this.asset(row);
    });
  }
  async findByIds(ids: string[]): Promise<OutfitMediaAsset[]> {
    if (!ids.length) return [];
    return (await this.database.db.select().from(outfitMediaAssets).where(inArray(outfitMediaAssets.id, ids))).map(row => this.asset(row));
  }
  async findOwnedReady(id: string, userId: string): Promise<OutfitMediaAsset | null> {
    const [row] = await this.database.db.select().from(outfitMediaAssets).where(and(eq(outfitMediaAssets.id, id), eq(outfitMediaAssets.status, OUTFIT_MEDIA.status.ready)));
    if (!row) return null;
    const asset = this.asset(row);
    return await findAuthoringProfile(this.database, asset, userId, ProfileAccessMode.Read) ? asset : null;
  }
  async findPublic(id: string, canonicalUrl: string): Promise<OutfitMediaAsset | null> {
    const creator = this.database.db.select({id: creatorProfiles.id}).from(creatorProfiles).innerJoin(users, eq(users.id, creatorProfiles.userId))
      .where(and(eq(creatorProfiles.id, outfits.creatorId), eq(creatorProfiles.status, PUBLIC_PROFILE.status), eq(users.status, PUBLIC_PROFILE.userStatus)));
    const brand = this.database.db.select({id: brandProfiles.id}).from(brandProfiles).where(and(eq(brandProfiles.id, outfits.brandId), eq(brandProfiles.status, PUBLIC_PROFILE.status)));
    const reference = this.database.db.select({id: outfitImages.id}).from(outfitImages).innerJoin(outfits, eq(outfits.id, outfitImages.outfitId))
      .where(and(eq(outfitImages.url, canonicalUrl), eq(outfits.status, PUBLIC_OUTFIT.status), inArray(outfits.visibility, PUBLIC_OUTFIT_VISIBILITIES),
        or(and(eq(outfits.creatorId, outfitMediaAssets.creatorId), isNull(outfits.brandId), isNull(outfitMediaAssets.brandId), exists(creator)),
          and(eq(outfits.brandId, outfitMediaAssets.brandId), isNull(outfits.creatorId), isNull(outfitMediaAssets.creatorId), exists(brand)))));
    const [row] = await this.database.db.select().from(outfitMediaAssets).where(and(eq(outfitMediaAssets.id, id), eq(outfitMediaAssets.status, OUTFIT_MEDIA.status.ready), exists(reference)));
    return row ? this.asset(row) : null;
  }
}
