import {and, asc, eq, inArray, or} from 'drizzle-orm';
import type {DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {brandProfiles, creatorProfiles, users, userRoles, brandMembers, commissions, connectAccounts} from '../../../shared/infrastructure/database/schema';
import {PAYMENT_ALLOCATION as C, type StoredAllocationPlan} from '../domain/payment-allocation';

/** Order first (caller), then sorted identities, profiles, commissions and Connect associations. */
export async function lockDisbursementRecipients(database: DatabaseSession, plan: StoredAllocationPlan, liveMode: boolean): Promise<boolean> {
  const creatorIds = [...new Set(plan.lines.flatMap(line => line.recipient.kind === C.kind.creator ? [line.recipient.beneficiaryId] : []))];
  const commissionIds = plan.lines.flatMap(line => line.recipient.kind === C.kind.creator ? [line.recipient.commissionId] : []);
  const [brand] = await database.db.select({id: brandProfiles.id, owner: brandProfiles.ownerUserId}).from(brandProfiles).where(eq(brandProfiles.id, plan.brandId));
  const creators = creatorIds.length ? await database.db.select({id: creatorProfiles.id, owner: creatorProfiles.userId})
    .from(creatorProfiles).where(inArray(creatorProfiles.id, creatorIds)) : [];
  if (!brand || creators.length !== creatorIds.length) return false;
  const owners = [...new Set([brand.owner, ...creators.map(row => row.owner)])];
  const identities = await database.db.select({id: users.id}).from(users).where(inArray(users.id, owners)).orderBy(asc(users.id)).for(C.lock);
  if (identities.length !== owners.length) return false;
  await database.db.select({id: userRoles.id}).from(userRoles).where(inArray(userRoles.userId, owners))
    .orderBy(asc(userRoles.userId), asc(userRoles.role)).for(C.lock);
  const [lockedBrand] = await database.db.select({owner: brandProfiles.ownerUserId}).from(brandProfiles).where(eq(brandProfiles.id, plan.brandId)).for(C.lock);
  const lockedCreators = creatorIds.length ? await database.db.select({id: creatorProfiles.id, owner: creatorProfiles.userId}).from(creatorProfiles)
    .where(inArray(creatorProfiles.id, creatorIds)).orderBy(asc(creatorProfiles.id)).for(C.lock) : [];
  if (!lockedBrand || lockedBrand.owner !== brand.owner || lockedCreators.length !== creators.length
    || lockedCreators.some(row => !creators.some(original => original.id === row.id && original.owner === row.owner))) return false;
  await database.db.select({id: brandMembers.id}).from(brandMembers).where(and(eq(brandMembers.brandProfileId, plan.brandId), eq(brandMembers.userId, brand.owner)))
    .orderBy(asc(brandMembers.id)).for(C.lock);
  if (commissionIds.length) await database.db.select({id: commissions.id}).from(commissions).where(inArray(commissions.id, commissionIds)).orderBy(asc(commissions.id)).for(C.lock);
  await database.db.select({id: connectAccounts.id}).from(connectAccounts).where(and(eq(connectAccounts.liveMode, liveMode),
    or(eq(connectAccounts.brandId, plan.brandId), creatorIds.length ? inArray(connectAccounts.creatorId, creatorIds) : undefined)))
    .orderBy(asc(connectAccounts.id)).for(C.lock);
  return true;
}
