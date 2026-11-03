import {BadRequestException, ConflictException, Inject, Injectable, InternalServerErrorException} from '@nestjs/common';
import {and, asc, desc, eq, gt, inArray, lt, or, sql} from 'drizzle-orm';
import {DatabaseService} from '../../../../shared/infrastructure/database/database.service';
import {READ_SNAPSHOT, type DatabaseSession} from '../../../../shared/infrastructure/database/database-session';
import {brandMembers, brandProfiles, creatorProfiles, profileStatusChanges, users, userRoles} from '../../../../shared/infrastructure/database/schema';
import {PROFILE_AUTHOR_ROLES, PROFILE_EDITING} from '../../../../shared/domain/profile-editing.contract';
import {findIdentityAccess, IdentityAccessMode} from './identity-access';
import {USER_ADMINISTRATION as U, userAdministrationIdentifierSchema} from '../../domain/user-administration.contract';
import {PROFILE_ADMINISTRATION as P, profileAdministrationKindSchema, type AdministeredProfileKind, type AdministeredProfileState, type ChangeProfileStatus, type ProfileAdministrationQuery, type ProfileStatusChange} from '../../domain/profile-administration.contract';
import type {ProfileAdministrationRepository} from '../../domain/profile-administration.repository';

@Injectable()
export class DrizzleProfileAdministrationRepository implements ProfileAdministrationRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseSession) {}
  transaction<T>(write: boolean, operation: (repository: ProfileAdministrationRepository) => Promise<T>): Promise<T> {
    return this.database.db.transaction(tx => operation(new DrizzleProfileAdministrationRepository({db: tx})), write ? undefined : READ_SNAPSHOT);
  }
  findAccess(actorId: string, lock: boolean) { return findIdentityAccess(this.database, actorId, lock ? IdentityAccessMode.Lock : IdentityAccessMode.Read); }
  async lockIdentities(actorId: string, userId: string) {
    const ids = [...new Set([actorId, userId])];
    const locked = await this.database.db.select({id: users.id}).from(users).where(inArray(users.id, ids)).orderBy(asc(users.id)).for(U.persistence.lock);
    return locked.length === ids.length;
  }
  async list(userId: string, kind: AdministeredProfileKind, query: ProfileAdministrationQuery) {
    const table = profileTable(kind), scope = associatedUser(kind, userId);
    if (query.cursor) {
      const [anchor] = await this.database.db.select({id: table.id}).from(table).where(and(scope, eq(table.id, query.cursor))).limit(U.limits.one);
      if (!anchor) throw new BadRequestException(U.failure.cursor);
    }
    const rows = await this.read(kind).where(and(scope, query.cursor ? gt(table.id, query.cursor) : undefined)).orderBy(asc(table.id)).limit(query.limit + U.limits.step);
    const items = rows.slice(U.limits.first, query.limit).map(row => project(row, kind));
    return {items, nextCursor: rows.length > query.limit ? items.at(-U.limits.one)!.id : null};
  }
  async current(userId: string, kind: AdministeredProfileKind, profileId: string, lock: boolean) {
    const table = profileTable(kind), filter = and(eq(table.id, profileId), associatedUser(kind, userId));
    if (lock) {
      const [locked] = await this.database.db.select({id: table.id}).from(table).where(filter).for(U.persistence.lock);
      if (!locked) return undefined;
    }
    const [row] = await this.read(kind).where(filter).limit(U.limits.one);
    return row ? project(row, kind) : undefined;
  }
  async history(kind: AdministeredProfileKind, profileId: string, query: ProfileAdministrationQuery) {
    const scope = eq(kind === P.kind.creator ? profileStatusChanges.creatorId : profileStatusChanges.brandId, profileId);
    let anchorVersion: number | undefined;
    if (query.cursor) {
      const [anchor] = await this.database.db.select({version: profileStatusChanges.version}).from(profileStatusChanges)
        .where(and(scope, eq(profileStatusChanges.id, query.cursor))).limit(U.limits.one);
      if (!anchor) throw new BadRequestException(U.failure.cursor);
      anchorVersion = anchor.version;
    }
    const rows = await this.database.db.select().from(profileStatusChanges)
      .where(and(scope, anchorVersion === undefined ? undefined : lt(profileStatusChanges.version, anchorVersion)))
      .orderBy(desc(profileStatusChanges.version)).limit(query.limit + U.limits.step);
    const items = rows.slice(U.limits.first, query.limit).map(row => projectChange(row, kind, profileId));
    return {items, nextCursor: rows.length > query.limit ? items.at(-U.limits.one)!.id : null};
  }
  async change(current: AdministeredProfileState, input: ChangeProfileStatus, actorId: string) {
    const table = profileTable(current.kind);
    const [updated] = await this.database.db.update(table).set({status: input.status, statusVersion: current.version + U.limits.step, updatedAt: new Date()})
      .where(and(eq(table.id, current.id), eq(table.statusVersion, input.expectedVersion), eq(table.status, current.status))).returning({id: table.id});
    if (!updated) throw new ConflictException(P.failure.changed);
    const [row] = await this.read(current.kind).where(eq(table.id, current.id)).limit(U.limits.one);
    if (!row) throw invalid();
    const next = project(row, current.kind);
    if (next.version !== current.version + U.limits.step || next.status !== input.status) throw invalid();
    await this.database.db.insert(profileStatusChanges).values({
      creatorId: current.kind === P.kind.creator ? current.id : null, brandId: current.kind === P.kind.brand ? current.id : null,
      version: next.version, fromStatus: current.status, toStatus: next.status, decidedByUserId: actorId, reason: input.reason,
    });
    return next;
  }
  private read(kind: AdministeredProfileKind) {
    const table = profileTable(kind);
    const creatorOperator = sql<boolean>`exists(select ${PROFILE_EDITING.persistence.existsProjection} from ${users} join ${userRoles} on ${userRoles.userId}=${users.id}
      where ${users.id}=${creatorProfiles.userId} and ${users.status}=${U.status.active} and ${userRoles.role}=${PROFILE_AUTHOR_ROLES.creator})`;
    const brandOperator = sql<boolean>`exists(select ${PROFILE_EDITING.persistence.existsProjection} from ${brandMembers} join ${users} on ${users.id}=${brandMembers.userId}
      join ${userRoles} on ${userRoles.userId}=${users.id} where ${brandMembers.brandProfileId}=${brandProfiles.id}
      and ${brandMembers.status}=${PROFILE_EDITING.persistence.memberActive} and ${users.status}=${U.status.active}
      and ${userRoles.role} in (${PROFILE_AUTHOR_ROLES.brandOwner},${PROFILE_AUTHOR_ROLES.brandManager}))`;
    return this.database.db.select({id: table.id, name: kind === P.kind.creator ? creatorProfiles.displayName : brandProfiles.brandName,
      slug: table.slug, status: table.status, version: table.statusVersion, createdAt: table.createdAt, updatedAt: table.updatedAt,
      hasActiveOperator: sql<boolean>`${kind === P.kind.creator ? creatorOperator : brandOperator}`}).from(table);
  }
}
function profileTable(kind: AdministeredProfileKind) { return kind === P.kind.creator ? creatorProfiles : brandProfiles; }
function associatedUser(kind: AdministeredProfileKind, userId: string) {
  return kind === P.kind.creator ? eq(creatorProfiles.userId, userId) : or(eq(brandProfiles.ownerUserId, userId),
    sql`exists(select ${PROFILE_EDITING.persistence.existsProjection} from ${brandMembers} where ${brandMembers.brandProfileId}=${brandProfiles.id} and ${brandMembers.userId}=${userId} and ${brandMembers.status}=${PROFILE_EDITING.persistence.memberActive})`);
}
function project(row: {id: string; name: string; slug: string; status: AdministeredProfileState['status']; version: number; createdAt: Date; updatedAt: Date; hasActiveOperator: boolean}, kind: AdministeredProfileKind): AdministeredProfileState {
  if (!userAdministrationIdentifierSchema.safeParse(row.id).success || !profileAdministrationKindSchema.safeParse(kind).success ||
      !row.name.trim() || !row.slug.trim() || !validVersion(row.version) || typeof row.hasActiveOperator !== 'boolean') throw invalid();
  return {...row, kind, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString()};
}
function projectChange(row: typeof profileStatusChanges.$inferSelect, kind: AdministeredProfileKind, profileId: string): ProfileStatusChange {
  if (![row.id, row.decidedByUserId, profileId].every(id => userAdministrationIdentifierSchema.safeParse(id).success) ||
      !validVersion(row.version) || row.version === U.limits.initialVersion || row.fromStatus === row.toStatus ||
      !row.reason.trim() || row.reason !== row.reason.trim() || row.reason.length > U.limits.reason) throw invalid();
  return {id: row.id, profileId, kind, version: row.version, fromStatus: row.fromStatus, toStatus: row.toStatus,
    decidedByUserId: row.decidedByUserId, reason: row.reason, createdAt: row.createdAt.toISOString()};
}
function validVersion(value: number) { return Number.isInteger(value) && value >= U.limits.initialVersion && value <= U.limits.maximumVersion; }
function invalid() { return new InternalServerErrorException(P.failure.persisted); }
