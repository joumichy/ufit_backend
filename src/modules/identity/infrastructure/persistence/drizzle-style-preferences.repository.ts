import {createHash} from 'node:crypto';
import {BadRequestException, ConflictException, ForbiddenException, Inject, Injectable} from '@nestjs/common';
import {and, eq, inArray} from 'drizzle-orm';
import {DatabaseService} from '../../../../shared/infrastructure/database/database.service';
import {READ_SNAPSHOT, type DatabaseSession} from '../../../../shared/infrastructure/database/database-session';
import {users} from '../../../../shared/infrastructure/database/schema.identity';
import {tags} from '../../../../shared/infrastructure/database/schema.tags';
import {preferredStyles, stylePreferenceChanges, stylePreferences} from '../../../../shared/infrastructure/database/schema.style-preferences';
import {STYLE_PREFERENCES as S, stylePreferencesInputSchema, stylePreferencesDocumentSchema, stylePreferencesReceiptSchema,
  type StylePreferencesDocument, type StylePreferencesReceipt, type StylePreferenceChangeStatus} from '../../domain/style-preferences.contract';

@Injectable()
export class DrizzleStylePreferencesRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseSession) {}
  read(userId: string): Promise<StylePreferencesDocument> {
    return this.database.db.transaction(async db => {
      await requireAccount({db}, userId, false);
      return current({db}, userId);
    }, READ_SNAPSHOT);
  }
  change(userId: string, requestId: string): Promise<StylePreferenceChangeStatus> {
    return this.database.db.transaction(async db => {
      await requireAccount({db}, userId, false);
      const [row] = await db.select().from(stylePreferenceChanges)
        .where(and(eq(stylePreferenceChanges.userId, userId), eq(stylePreferenceChanges.requestId, requestId))).limit(S.one);
      return {receipt: row ? stylePreferencesReceiptSchema.parse({requestId: row.requestId, version: row.version}) : null,
        preferences: await current({db}, userId)};
    }, READ_SNAPSHOT);
  }
  write(userId: string, raw: unknown): Promise<StylePreferencesReceipt> {
    const parsed = stylePreferencesInputSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(S.failure.invalid);
    const input = parsed.data;
    const fingerprint = createHash(S.digest.algorithm).update(JSON.stringify({expectedVersion: input.expectedVersion, styleIds: input.styleIds})).digest(S.digest.encoding);
    return this.database.db.transaction(async db => {
      // Account deletion and preference changes serialize on the same account row.
      await requireAccount({db}, userId, true);
      const [prior] = await db.select().from(stylePreferenceChanges)
        .where(and(eq(stylePreferenceChanges.userId, userId), eq(stylePreferenceChanges.requestId, input.requestId))).limit(S.one);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new ConflictException(S.failure.request);
        return stylePreferencesReceiptSchema.parse({requestId: prior.requestId, version: prior.version});
      }
      const previous = await current({db}, userId);
      if (previous.version !== input.expectedVersion) throw new ConflictException(S.failure.changed);
      if (input.styleIds.length) {
        const available = await db.select({id: tags.id}).from(tags).where(and(inArray(tags.id, input.styleIds), eq(tags.type, S.tagType)));
        if (available.length !== input.styleIds.length) throw new BadRequestException(S.failure.tags);
      }
      const saved = {userId, version: previous.version + S.version.step, updatedAt: new Date()};
      if (previous.version === S.version.absent) await db.insert(stylePreferences).values(saved);
      else await db.update(stylePreferences).set(saved).where(eq(stylePreferences.userId, userId));
      await db.delete(preferredStyles).where(eq(preferredStyles.userId, userId));
      if (input.styleIds.length) await db.insert(preferredStyles).values(input.styleIds.map(tagId => ({userId, tagId, tagType: S.tagType})));
      await db.insert(stylePreferenceChanges).values({userId, requestId: input.requestId, fingerprint,
        expectedVersion: input.expectedVersion, version: saved.version, createdAt: saved.updatedAt});
      return stylePreferencesReceiptSchema.parse({requestId: input.requestId, version: saved.version});
    });
  }
}
async function requireAccount(database: DatabaseSession, id: string, lock: boolean) {
  const query = database.db.select({status: users.status}).from(users).where(eq(users.id, id)).limit(S.one);
  const [actor] = lock ? await query.for(S.lock) : await query;
  if (!actor || !S.readableStatuses.some(status => actor.status === status)) throw new ForbiddenException(S.failure.unavailable);
}
async function current(database: DatabaseSession, userId: string): Promise<StylePreferencesDocument> {
  const [document] = await database.db.select().from(stylePreferences).where(eq(stylePreferences.userId, userId)).limit(S.one);
  const selected = document ? await database.db.select({id: preferredStyles.tagId}).from(preferredStyles)
    .where(eq(preferredStyles.userId, userId)).orderBy(preferredStyles.tagId) : [];
  return stylePreferencesDocumentSchema.parse(document ? {userId, version: document.version, styleIds: selected.map(row => row.id), updatedAt: document.updatedAt.toISOString()}
    : {userId, version: S.version.absent, styleIds: [], updatedAt: null});
}
