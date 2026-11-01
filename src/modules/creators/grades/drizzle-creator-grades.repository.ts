import {BadRequestException, ConflictException, Inject, Injectable, InternalServerErrorException} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import {and, asc, desc, eq, gt, ilike, inArray, lt, or, sql} from 'drizzle-orm';
import {DatabaseService} from '../../../shared/infrastructure/database/database.service';
import {READ_SNAPSHOT, type DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {creatorGrades, creatorGradeRevisions, creatorGradeHistory, creatorProfiles, users} from '../../../shared/infrastructure/database/schema';
import {findIdentityAccess, IdentityAccessMode} from '../../identity/infrastructure/persistence/identity-access';
import type {CreatorGradeRepository, CreatorGradeAssignmentState} from './creator-grade.repository';
import {
  CREATOR_GRADE, creatorGradeCodeSchema, type ChangeCreatorGrade, type CreateCreatorGrade,
  type CreatorGradeAssignmentQuery, type CreatorGradeDefinition, type CreatorGradeHistoryQuery,
  type CreatorGradeQuery, type CreatorGradeRevision, type ReviseCreatorGrade,
} from './creator-grade.contract';

@Injectable()
export class DrizzleCreatorGradesRepository implements CreatorGradeRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseSession) {}
  transaction<T>(write: boolean, operation: (repository: CreatorGradeRepository) => Promise<T>): Promise<T> {
    return this.database.db.transaction(tx => operation(new DrizzleCreatorGradesRepository({db: tx})), write ? undefined : READ_SNAPSHOT);
  }
  findAccess(actorId: string, write: boolean) {
    return findIdentityAccess(this.database, actorId, write ? IdentityAccessMode.Lock : IdentityAccessMode.Read);
  }
  async list(query: CreatorGradeQuery) {
    const term = searchTerm(query.search), filter = and(
      query.assignable === undefined ? undefined : eq(creatorGrades.assignable, query.assignable),
      term ? or(ilike(creatorGrades.label, term), ilike(creatorGrades.code, term)) : undefined);
    if (query.cursor) {
      const [anchor] = await this.database.db.select({code: creatorGrades.code}).from(creatorGrades)
        .where(and(filter, eq(creatorGrades.code, query.cursor))).limit(CREATOR_GRADE.limits.single);
      if (!anchor) throw new BadRequestException(CREATOR_GRADE.failure.cursor);
    }
    const rows = await readDefinitions(this.database).where(and(filter, query.cursor ? gt(creatorGrades.code, query.cursor) : undefined))
      .orderBy(asc(creatorGrades.code)).limit(query.limit + CREATOR_GRADE.limits.increment);
    const items = rows.slice(CREATOR_GRADE.limits.first, query.limit).map(projectDefinition);
    return {items, nextCursor: rows.length > query.limit ? items.at(-CREATOR_GRADE.limits.single)!.code : null};
  }
  async current(code: string, lock: boolean) {
    if (lock) await this.database.db.select({code: creatorGrades.code}).from(creatorGrades)
      .where(eq(creatorGrades.code, code)).for(CREATOR_GRADE.persistence.lock);
    const [row] = await readDefinitions(this.database).where(eq(creatorGrades.code, code)).limit(CREATOR_GRADE.limits.single);
    return row ? projectDefinition(row) : undefined;
  }
  async history(code: string, query: CreatorGradeHistoryQuery) {
    const filter = eq(creatorGradeRevisions.code, code);
    let anchorVersion: number | undefined;
    if (query.cursor) {
      const [anchor] = await this.database.db.select({version: creatorGradeRevisions.version}).from(creatorGradeRevisions)
        .where(and(filter, eq(creatorGradeRevisions.id, query.cursor))).limit(CREATOR_GRADE.limits.single);
      if (!anchor) throw new BadRequestException(CREATOR_GRADE.failure.cursor);
      anchorVersion = anchor.version;
    }
    const rows = await this.database.db.select().from(creatorGradeRevisions)
      .where(and(filter, anchorVersion === undefined ? undefined : lt(creatorGradeRevisions.version, anchorVersion)))
      .orderBy(desc(creatorGradeRevisions.version)).limit(query.limit + CREATOR_GRADE.limits.increment);
    const items = rows.slice(CREATOR_GRADE.limits.first, query.limit).map(projectRevision);
    return {items, nextCursor: rows.length > query.limit ? items.at(-CREATOR_GRADE.limits.single)!.id : null};
  }
  async create(input: CreateCreatorGrade, actorId: string) {
    const recordedAt = new Date();
    const [created] = await this.database.db.insert(creatorGrades).values({code: input.code, label: input.label, rank: input.rank,
      assignable: input.assignable, version: CREATOR_GRADE.limits.initialVersion, commissionBps: null, createdAt: recordedAt, updatedAt: recordedAt})
      .onConflictDoNothing().returning({code: creatorGrades.code});
    if (!created) return undefined;
    await this.database.db.insert(creatorGradeRevisions).values({id: randomUUID(), code: input.code, version: CREATOR_GRADE.limits.initialVersion,
      previousRevisionId: null, label: input.label, rank: input.rank, assignable: input.assignable, changedByUserId: actorId, reason: input.reason, recordedAt});
    return this.requireCreated(created.code);
  }
  async revise(current: CreatorGradeDefinition, input: ReviseCreatorGrade, actorId: string) {
    const recordedAt = new Date(), version = current.version + CREATOR_GRADE.limits.increment;
    const [updated] = await this.database.db.update(creatorGrades).set({label: input.label, rank: input.rank, assignable: input.assignable, version, updatedAt: recordedAt})
      .where(and(eq(creatorGrades.code, current.code), eq(creatorGrades.version, input.expectedVersion))).returning({code: creatorGrades.code});
    if (!updated) throw new ConflictException(CREATOR_GRADE.failure.changed);
    await this.database.db.insert(creatorGradeRevisions).values({id: randomUUID(), code: current.code, version, previousRevisionId: current.revisionId,
      label: input.label, rank: input.rank, assignable: input.assignable, changedByUserId: actorId, reason: input.reason, recordedAt});
    return this.requireCreated(updated.code);
  }
  async assignments(query: CreatorGradeAssignmentQuery) {
    const term = searchTerm(query.search), filter = term ? or(ilike(creatorProfiles.displayName, term), ilike(creatorProfiles.slug, term)) : undefined;
    if (query.cursor) {
      const [anchor] = await this.database.db.select({id: creatorProfiles.id}).from(creatorProfiles)
        .where(and(filter, eq(creatorProfiles.id, query.cursor))).limit(CREATOR_GRADE.limits.single);
      if (!anchor) throw new BadRequestException(CREATOR_GRADE.failure.cursor);
    }
    const rows = await readAssignments(this.database).where(and(filter, query.cursor ? gt(creatorProfiles.id, query.cursor) : undefined))
      .orderBy(asc(creatorProfiles.id)).limit(query.limit + CREATOR_GRADE.limits.increment);
    const items = rows.slice(CREATOR_GRADE.limits.first, query.limit).map(row => projectAssignment(row).assignment);
    return {items, nextCursor: rows.length > query.limit ? items.at(-CREATOR_GRADE.limits.single)!.creatorId : null};
  }
  async lockAssignmentIdentities(actorId: string, creatorId: string) {
    const [profile] = await this.database.db.select({userId: creatorProfiles.userId}).from(creatorProfiles)
      .where(eq(creatorProfiles.id, creatorId)).limit(CREATOR_GRADE.limits.single);
    if (!profile) return undefined;
    const identities = [...new Set([actorId, profile.userId])].sort();
    const locked = await this.database.db.select({id: users.id}).from(users).where(inArray(users.id, identities))
      .orderBy(asc(users.id)).for(CREATOR_GRADE.persistence.lock);
    return locked.length === identities.length ? profile.userId : undefined;
  }
  async currentAssignment(creatorId: string, lock: boolean) {
    if (lock) await this.database.db.select({id: creatorProfiles.id}).from(creatorProfiles)
      .where(eq(creatorProfiles.id, creatorId)).for(CREATOR_GRADE.persistence.lock);
    const [row] = await readAssignments(this.database).where(eq(creatorProfiles.id, creatorId)).limit(CREATOR_GRADE.limits.single);
    return row ? projectAssignment(row) : undefined;
  }
  async assignmentHistory(creatorId: string, query: CreatorGradeHistoryQuery) {
    const filter = eq(creatorGradeHistory.creatorProfileId, creatorId);
    let anchor: typeof creatorGradeHistory.$inferSelect | undefined;
    if (query.cursor) {
      [anchor] = await this.database.db.select().from(creatorGradeHistory)
        .where(and(filter, eq(creatorGradeHistory.id, query.cursor))).limit(CREATOR_GRADE.limits.single);
      if (!anchor) throw new BadRequestException(CREATOR_GRADE.failure.cursor);
    }
    const rows = await this.database.db.select().from(creatorGradeHistory)
      .where(and(filter, anchor ? sql`(${creatorGradeHistory.createdAt}, ${creatorGradeHistory.id}) < (select ${creatorGradeHistory.createdAt}, ${creatorGradeHistory.id} from ${creatorGradeHistory} where ${creatorGradeHistory.id} = ${anchor.id})` : undefined))
      .orderBy(desc(creatorGradeHistory.createdAt), desc(creatorGradeHistory.id)).limit(query.limit + CREATOR_GRADE.limits.increment);
    const items = rows.slice(CREATOR_GRADE.limits.first, query.limit).map(projectChange);
    return {items, nextCursor: rows.length > query.limit ? items.at(-CREATOR_GRADE.limits.single)!.id : null};
  }
  async change(current: CreatorGradeAssignmentState, target: CreatorGradeDefinition, input: ChangeCreatorGrade, actorId: string) {
    const createdAt = new Date(), version = current.assignment.version + CREATOR_GRADE.limits.increment;
    const [updated] = await this.database.db.update(creatorProfiles).set({gradeCode: target.code, gradeVersion: version, updatedAt: createdAt})
      .where(and(eq(creatorProfiles.id, current.assignment.creatorId), eq(creatorProfiles.userId, current.userId),
        eq(creatorProfiles.gradeVersion, input.expectedVersion), eq(creatorProfiles.gradeCode, current.assignment.gradeCode)))
      .returning({id: creatorProfiles.id});
    if (!updated) throw new ConflictException(CREATOR_GRADE.failure.assignmentChanged);
    const [recorded] = await this.database.db.insert(creatorGradeHistory).values({id: randomUUID(), creatorProfileId: updated.id, version,
      source: CREATOR_GRADE.changeSource.administration, fromGradeCode: current.assignment.gradeCode, fromGradeLabel: current.assignment.gradeLabel,
      toGradeCode: target.code, toGradeLabel: target.label, changedByUserId: actorId, reason: input.reason, createdAt}).returning();
    const result = await this.currentAssignment(updated.id, false);
    if (!recorded || !result) throw new InternalServerErrorException(CREATOR_GRADE.failure.persisted);
    return {assignment: result.assignment, change: projectChange(recorded)};
  }
  private async requireCreated(code: string) {
    const result = await this.current(code, false);
    if (!result) throw new InternalServerErrorException(CREATOR_GRADE.failure.persisted);
    return result;
  }
}

function searchTerm(search: string | undefined) {
  return search ? CREATOR_GRADE.persistence.wildcard + search.replace(CREATOR_GRADE.persistence.literalPattern, CREATOR_GRADE.persistence.escapedLiteral) + CREATOR_GRADE.persistence.wildcard : undefined;
}
function readDefinitions(database: DatabaseSession) {
  return database.db.select({grade: {code: creatorGrades.code, label: creatorGrades.label, rank: creatorGrades.rank,
    assignable: creatorGrades.assignable, version: creatorGrades.version, createdAt: creatorGrades.createdAt, updatedAt: creatorGrades.updatedAt},
    revisionId: creatorGradeRevisions.id,
    assignedCreators: sql<number>`(select count(*) from ${creatorProfiles} where ${creatorProfiles.gradeCode} = ${creatorGrades.code})`.mapWith(Number)})
    .from(creatorGrades).innerJoin(creatorGradeRevisions, and(eq(creatorGradeRevisions.code, creatorGrades.code), eq(creatorGradeRevisions.version, creatorGrades.version)));
}
function projectDefinition(row: Awaited<ReturnType<typeof readDefinitions>>[number]): CreatorGradeDefinition {
  if (!creatorGradeCodeSchema.safeParse(row.grade.code).success || !validLabel(row.grade.label) || !validInteger(row.grade.rank) ||
    !validVersion(row.grade.version) || !Number.isSafeInteger(row.assignedCreators) || row.assignedCreators < CREATOR_GRADE.limits.zero) throw invalid();
  return {...row.grade, isInitial: row.grade.code === CREATOR_GRADE.initialCode, revisionId: row.revisionId, assignedCreators: row.assignedCreators,
    createdAt: row.grade.createdAt.toISOString(), updatedAt: row.grade.updatedAt === null ? null : row.grade.updatedAt.toISOString()};
}
function projectRevision(row: typeof creatorGradeRevisions.$inferSelect): CreatorGradeRevision {
  if (!creatorGradeCodeSchema.safeParse(row.code).success || !validLabel(row.label) || !validInteger(row.rank) || !validVersion(row.version) ||
    (row.version === CREATOR_GRADE.limits.initialVersion) !== (row.previousRevisionId === null)) throw invalid();
  return {...row, recordedAt: row.recordedAt.toISOString()};
}
function readAssignments(database: DatabaseSession) {
  return database.db.select({creator: {id: creatorProfiles.id, userId: creatorProfiles.userId, displayName: creatorProfiles.displayName,
    slug: creatorProfiles.slug, status: creatorProfiles.status, gradeCode: creatorProfiles.gradeCode, version: creatorProfiles.gradeVersion},
    accountStatus: users.status, gradeLabel: creatorGrades.label, gradeRank: creatorGrades.rank})
    .from(creatorProfiles).innerJoin(users, eq(users.id, creatorProfiles.userId)).innerJoin(creatorGrades, eq(creatorGrades.code, creatorProfiles.gradeCode));
}
function projectAssignment(row: Awaited<ReturnType<typeof readAssignments>>[number]): CreatorGradeAssignmentState {
  if (!validVersion(row.creator.version) || !validLabel(row.gradeLabel) || !validInteger(row.gradeRank)) throw invalid();
  return {userId: row.creator.userId, assignment: {creatorId: row.creator.id, displayName: row.creator.displayName, slug: row.creator.slug,
    creatorStatus: row.creator.status, accountStatus: row.accountStatus, gradeCode: row.creator.gradeCode, gradeLabel: row.gradeLabel, gradeRank: row.gradeRank, version: row.creator.version}};
}
function projectChange(row: typeof creatorGradeHistory.$inferSelect) {
  if ((row.version === null) !== (row.source === null) || (row.version !== null && !validVersion(row.version))) throw invalid();
  return {id: row.id, creatorId: row.creatorProfileId, version: row.version, source: row.source,
    fromGradeCode: row.fromGradeCode, fromGradeLabel: row.fromGradeLabel, toGradeCode: row.toGradeCode, toGradeLabel: row.toGradeLabel,
    changedByUserId: row.changedByUserId, reason: row.reason, createdAt: row.createdAt.toISOString()};
}
function validInteger(value: number) { return Number.isInteger(value) && value >= CREATOR_GRADE.limits.zero && value <= CREATOR_GRADE.limits.maximumInteger; }
function validVersion(value: number) { return validInteger(value) && value >= CREATOR_GRADE.limits.initialVersion; }
function validLabel(value: string) { return value === value.trim() && value.length >= CREATOR_GRADE.limits.single && value.length <= CREATOR_GRADE.limits.label; }
function invalid() { return new InternalServerErrorException(CREATOR_GRADE.failure.persisted); }
