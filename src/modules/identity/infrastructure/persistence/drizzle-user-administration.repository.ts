import { BadRequestException, ConflictException, Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import { and, asc, desc, eq, gt, ilike, inArray, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DatabaseService } from '../../../../shared/infrastructure/database/database.service';
import { READ_SNAPSHOT, type DatabaseSession } from '../../../../shared/infrastructure/database/database-session';
import { users, userRoles, userAccessChanges } from '../../../../shared/infrastructure/database/schema';
import { findIdentityAccess, IdentityAccessMode } from './identity-access';
import { USER_ROLES, type UserRole } from '../../domain/user.types';
import { USER_ADMINISTRATION, userAdministrationIdentifierSchema, type ChangeUserAdminAccess, type ChangeUserStatus, type UserAdministrationQuery, type UserAccessHistoryQuery, type UserAccessChange } from '../../domain/user-administration.contract';
import type { UserAdministrationRepository, UserAdministrationState } from '../../domain/user-administration.repository';
@Injectable()
export class DrizzleUserAdministrationRepository implements UserAdministrationRepository {
    constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseSession) { }
    transaction<T>(write: boolean, operation: (repository: UserAdministrationRepository) => Promise<T>): Promise<T> {
        return this.database.db.transaction(tx => operation(new DrizzleUserAdministrationRepository({ db: tx })), write ? undefined : READ_SNAPSHOT);
    }
    findAccess(actorId: string, lock: boolean) { return findIdentityAccess(this.database, actorId, lock ? IdentityAccessMode.Lock : IdentityAccessMode.Read); }
    async lockIdentities(actorId: string, targetId: string) {
        const ids = [...new Set([actorId, targetId])];
        const locked = await this.database.db.select({ id: users.id }).from(users).where(inArray(users.id, ids)).orderBy(asc(users.id)).for(USER_ADMINISTRATION.persistence.lock);
        return locked.length === ids.length;
    }
    async list(query: UserAdministrationQuery) {
        const term = literalSearch(query.search), filter = and(query.status ? eq(users.status, query.status) : undefined, query.role ? sql `exists(select 1 from ${userRoles} where ${userRoles.userId}=${users.id} and ${userRoles.role}=${query.role})` : undefined, term ? or(ilike(users.displayName, term), ilike(users.email, term)) : undefined);
        if (query.cursor) {
            const [anchor] = await this.database.db.select({ id: users.id }).from(users).where(and(filter, eq(users.id, query.cursor))).limit(USER_ADMINISTRATION.limits.one);
            if (!anchor)
                throw new BadRequestException(USER_ADMINISTRATION.failure.cursor);
        }
        const rows = await readUsers(this.database).where(and(filter, query.cursor ? gt(users.id, query.cursor) : undefined))
            .orderBy(asc(users.id)).limit(query.limit + USER_ADMINISTRATION.limits.step);
        const items = rows.slice(USER_ADMINISTRATION.limits.first, query.limit).map(projectUser);
        return { items, nextCursor: rows.length > query.limit ? items.at(-USER_ADMINISTRATION.limits.one)!.id : null };
    }
    async current(userId: string, lock: boolean) {
        if (lock) {
            const [locked] = await this.database.db.select({ id: users.id }).from(users).where(eq(users.id, userId)).for(USER_ADMINISTRATION.persistence.lock);
            if (!locked)
                return undefined;
            await this.database.db.select({ id: userRoles.id }).from(userRoles).where(eq(userRoles.userId, userId)).orderBy(userRoles.role).for(USER_ADMINISTRATION.persistence.lock);
        }
        const [row] = await readUsers(this.database).where(eq(users.id, userId)).limit(USER_ADMINISTRATION.limits.one);
        return row ? projectUser(row) : undefined;
    }
    async history(userId: string, query: UserAccessHistoryQuery) {
        const filter = eq(userAccessChanges.userId, userId);
        let anchorVersion: number | undefined;
        if (query.cursor) {
            const [anchor] = await this.database.db.select({ version: userAccessChanges.version }).from(userAccessChanges)
                .where(and(filter, eq(userAccessChanges.id, query.cursor))).limit(USER_ADMINISTRATION.limits.one);
            if (!anchor)
                throw new BadRequestException(USER_ADMINISTRATION.failure.cursor);
            anchorVersion = anchor.version;
        }
        const rows = await this.database.db.select().from(userAccessChanges)
            .where(and(filter, anchorVersion === undefined ? undefined : lt(userAccessChanges.version, anchorVersion)))
            .orderBy(desc(userAccessChanges.version)).limit(query.limit + USER_ADMINISTRATION.limits.step);
        const items = rows.slice(USER_ADMINISTRATION.limits.first, query.limit).map(projectChange);
        return { items, nextCursor: rows.length > query.limit ? items.at(-USER_ADMINISTRATION.limits.one)!.id : null };
    }
    async changeStatus(current: UserAdministrationState, input: ChangeUserStatus, actorId: string) {
        const [updated] = await this.database.db.update(users).set({ status: input.status, accessVersion: current.version + USER_ADMINISTRATION.limits.step, updatedAt: new Date() })
            .where(and(eq(users.id, current.id), eq(users.accessVersion, input.expectedVersion), eq(users.status, current.status))).returning({ id: users.id });
        if (!updated)
            throw new ConflictException(USER_ADMINISTRATION.failure.changed);
        const next = await this.requireCurrent(updated.id);
        await this.recordChange(USER_ADMINISTRATION.change.status, current, next, actorId, input.reason);
        return next;
    }
    async changeAdminAccess(current: UserAdministrationState, input: ChangeUserAdminAccess, actorId: string) {
        const [locked] = await this.database.db.select({ id: users.id }).from(users)
            .where(and(eq(users.id, current.id), eq(users.accessVersion, input.expectedVersion))).for(USER_ADMINISTRATION.persistence.lock);
        if (!locked)
            throw new ConflictException(USER_ADMINISTRATION.failure.changed);
        const changed = input.enabled
            ? await this.database.db.insert(userRoles).values({ userId: current.id, role: USER_ADMINISTRATION.role.admin })
                .onConflictDoNothing({ target: [userRoles.userId, userRoles.role] }).returning({ id: userRoles.id })
            : await this.database.db.delete(userRoles).where(and(eq(userRoles.userId, current.id), eq(userRoles.role, USER_ADMINISTRATION.role.admin))).returning({ id: userRoles.id });
        if (changed.length !== USER_ADMINISTRATION.limits.one)
            throw new ConflictException(USER_ADMINISTRATION.failure.unchanged);
        const next = await this.requireCurrent(current.id);
        await this.recordChange(USER_ADMINISTRATION.change.adminAccess, current, next, actorId, input.reason);
        return next;
    }
    private async requireCurrent(userId: string) {
        const next = await this.current(userId, false);
        if (!next)
            throw invalid();
        return next;
    }
    private async recordChange(kind: UserAccessChange['kind'], previous: UserAdministrationState, next: UserAdministrationState, actorId: string, reason: string) {
        if (next.version !== previous.version + USER_ADMINISTRATION.limits.step)
            throw invalid();
        const [recorded] = await this.database.db.insert(userAccessChanges).values({ userId: next.id, version: next.version, kind,
            fromStatus: previous.status, toStatus: next.status, adminBefore: previous.roles.includes(USER_ADMINISTRATION.role.admin), adminAfter: next.roles.includes(USER_ADMINISTRATION.role.admin),
            decidedByUserId: actorId, reason, createdAt: new Date() }).returning({ id: userAccessChanges.id });
        if (!recorded)
            throw invalid();
    }
}
function readUsers(database: DatabaseSession) {
    const correlatedRoles = sql<UserRole[]> `array(select ${userRoles.role}::text from ${userRoles} where ${userRoles.userId}=${users.id} order by ${userRoles.role})`;
    return database.db.select({ id: users.id, email: users.email, displayName: users.displayName, status: users.status, version: users.accessVersion, createdAt: users.createdAt, updatedAt: users.updatedAt,
        // Drizzle strips top-level column qualifiers in single-table selections; preserve the correlated scope.
        roles: sql<UserRole[]> `${correlatedRoles}` }).from(users);
}
function projectUser(row: Awaited<ReturnType<typeof readUsers>>[number]): UserAdministrationState {
    if (!userAdministrationIdentifierSchema.safeParse(row.id).success || !row.email.trim() || !validVersion(row.version) ||
        !z.array(z.enum(USER_ROLES)).safeParse(row.roles).success || new Set(row.roles).size !== row.roles.length)
        throw invalid();
    return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
function projectChange(row: typeof userAccessChanges.$inferSelect): UserAccessChange {
    if (![row.id, row.userId, row.decidedByUserId].every(id => userAdministrationIdentifierSchema.safeParse(id).success) ||
        !validVersion(row.version) || row.version === USER_ADMINISTRATION.limits.initialVersion || !row.reason.trim() || row.reason !== row.reason.trim() || row.reason.length > USER_ADMINISTRATION.limits.reason)
        throw invalid();
    return { ...row, createdAt: row.createdAt.toISOString() };
}
function validVersion(value: number) { return Number.isInteger(value) && value >= USER_ADMINISTRATION.limits.initialVersion && value <= USER_ADMINISTRATION.limits.maximumVersion; }
function literalSearch(value: string | undefined) { return value ? USER_ADMINISTRATION.persistence.wildcard + value.replace(USER_ADMINISTRATION.persistence.literalPattern, USER_ADMINISTRATION.persistence.escapedLiteral) + USER_ADMINISTRATION.persistence.wildcard : undefined; }
function invalid() { return new InternalServerErrorException(USER_ADMINISTRATION.failure.persisted); }
