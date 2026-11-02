import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import { z } from "zod";
import { DatabaseService } from "../../shared/infrastructure/database/database.service";
import type { DatabaseSession } from "../../shared/infrastructure/database/database-session";
import { applicationReviews, brandApplications, creatorApplications, creatorProfiles } from "../../shared/infrastructure/database/schema";
import { APPLICATION, APPLICATION_ACTIVE_STATUSES, type ApplicationKind } from "./types/application-contract";
import { mapBrandApplication, mapCreatorApplication } from "./application-response.mapper";
import {availableApplicant} from './application-visibility';
const READ = {snapshot: {isolationLevel: "repeatable read", accessMode: "read only"}, column: {type: "type", name: "name", orderAt: "order_at"}, timestamp: {zone: "UTC", format: 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'}} as const;
const pageSchema = z.object({limit: z.coerce.number().int().min(APPLICATION.page.minimumLimit).max(APPLICATION.page.maximumLimit).default(APPLICATION.page.defaultLimit),
  cursor: z.string().optional(), type: z.enum([APPLICATION.kind.creator, APPLICATION.kind.brand]).optional(),
  status: z.enum([APPLICATION.page.pending, APPLICATION.page.all, ...Object.values(APPLICATION.status)]).default(APPLICATION.page.pending)}).strict();
const cursorSchema = z.object({id: z.uuid(), type: z.enum([APPLICATION.kind.creator, APPLICATION.kind.brand]), at: z.iso.datetime()}).strict();
type Executor = DatabaseSession["db"];
@Injectable()
export class DrizzleApplicationReader {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseSession) {}
  current(userId: string) {
    return this.database.db.transaction(async tx => {
      const [[creator], [brand], profiles] = await Promise.all([
        tx.select().from(creatorApplications).where(eq(creatorApplications.userId, userId)).orderBy(desc(creatorApplications.submittedAt), desc(creatorApplications.id)).limit(APPLICATION.limits.row),
        tx.select().from(brandApplications).where(eq(brandApplications.userId, userId)).orderBy(desc(brandApplications.submittedAt), desc(brandApplications.id)).limit(APPLICATION.limits.row),
        tx.select({id: creatorProfiles.id}).from(creatorProfiles).where(eq(creatorProfiles.userId, userId)).limit(APPLICATION.limits.row),
      ]);
      return {creator: creator ? mapCreatorApplication(creator, await this.review(tx, APPLICATION.kind.creator, creator.id)) : null,
        brand: brand ? mapBrandApplication(brand, await this.review(tx, APPLICATION.kind.brand, brand.id)) : null,
        canApplyCreator: !profiles.length && (!creator || (creator.status !== APPLICATION.status.accepted && !(APPLICATION_ACTIVE_STATUSES as readonly string[]).includes(creator.status))),
        canApplyBrand: !brand || !(APPLICATION_ACTIVE_STATUSES as readonly string[]).includes(brand.status)};
    }, READ.snapshot);
  }
  owned(kind: ApplicationKind, id: string, userId: string) { return this.detail(kind, id, userId); }
  admin(kind: ApplicationKind, id: string) { return this.detail(kind, id); }
  private detail(kind: ApplicationKind, id: string, userId?: string) {
    return this.database.db.transaction(async tx => {
      if (kind === APPLICATION.kind.creator) {
        const [row] = await tx.select().from(creatorApplications).where(and(eq(creatorApplications.id, id),availableApplicant(creatorApplications.userId), userId ? eq(creatorApplications.userId, userId) : undefined)).limit(APPLICATION.limits.row);
        if (!row) throw new NotFoundException(APPLICATION.failure.notFound);
        return mapCreatorApplication(row, await this.review(tx, kind, id));
      }
      const [row] = await tx.select().from(brandApplications).where(and(eq(brandApplications.id, id),availableApplicant(brandApplications.userId), userId ? eq(brandApplications.userId, userId) : undefined)).limit(APPLICATION.limits.row);
      if (!row) throw new NotFoundException(APPLICATION.failure.notFound);
      return mapBrandApplication(row, await this.review(tx, kind, id));
    }, READ.snapshot);
  }
  private async review(db: Executor, kind: ApplicationKind, id: string) {
    const [row] = await db.select().from(applicationReviews).where(and(eq(applicationReviews.applicationType, kind), eq(applicationReviews.applicationId, id)))
      .orderBy(desc(applicationReviews.createdAt), desc(applicationReviews.id)).limit(APPLICATION.limits.row);
    return row ?? null;
  }
  async queue(raw: unknown) {
    const parsed = pageSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(APPLICATION.failure.page);
    const input = parsed.data;
    let cursor: z.infer<typeof cursorSchema> | undefined;
    if (input.cursor) {
      try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, APPLICATION.page.encoding).toString())); }
      catch { throw new BadRequestException(APPLICATION.failure.page); }
    }
    const db = this.database.db;
    const candidates = unionAll(
      db.select({id: creatorApplications.id, type: sql<ApplicationKind>`${APPLICATION.kind.creator}`.as(READ.column.type), name: sql<string>`${creatorApplications.displayName}`.as(READ.column.name),
        status: creatorApplications.status, version: creatorApplications.version, submittedAt: creatorApplications.submittedAt, updatedAt: creatorApplications.updatedAt,
        orderAt: sql<string>`to_char(${creatorApplications.submittedAt} at time zone ${READ.timestamp.zone}, ${READ.timestamp.format})`.as(READ.column.orderAt)}).from(creatorApplications).where(availableApplicant(creatorApplications.userId)),
      db.select({id: brandApplications.id, type: sql<ApplicationKind>`${APPLICATION.kind.brand}`.as(READ.column.type), name: sql<string>`${brandApplications.brandName}`.as(READ.column.name),
        status: brandApplications.status, version: brandApplications.version, submittedAt: brandApplications.submittedAt, updatedAt: brandApplications.updatedAt,
        orderAt: sql<string>`to_char(${brandApplications.submittedAt} at time zone ${READ.timestamp.zone}, ${READ.timestamp.format})`.as(READ.column.orderAt)}).from(brandApplications).where(availableApplicant(brandApplications.userId)),
    ).as(APPLICATION.page.alias);
    const rows = await db.select().from(candidates).where(and(
      input.type ? eq(candidates.type, input.type) : undefined,
      input.status === APPLICATION.page.all ? undefined : input.status === APPLICATION.page.pending ? inArray(candidates.status, [APPLICATION.status.submitted, APPLICATION.status.underReview]) : eq(candidates.status, input.status),
      cursor ? or(lt(candidates.submittedAt, sql`${cursor.at}::timestamptz`), and(eq(candidates.submittedAt, sql`${cursor.at}::timestamptz`), lt(candidates.id, cursor.id)),
        and(eq(candidates.submittedAt, sql`${cursor.at}::timestamptz`), eq(candidates.id, cursor.id), lt(candidates.type, cursor.type))) : undefined,
    )).orderBy(desc(candidates.submittedAt), desc(candidates.id), desc(candidates.type)).limit(input.limit + APPLICATION.page.overflow);
    const page = rows.slice(undefined, input.limit);
    const items = page.map(({orderAt, ...row}) => ({...row, submittedAt: row.submittedAt.toISOString(), updatedAt: row.updatedAt.toISOString()}));
    const last = page.at(APPLICATION.page.lastIndex);
    return {items, nextCursor: rows.length > input.limit && last ? Buffer.from(JSON.stringify({id: last.id, type: last.type, at: last.orderAt})).toString(APPLICATION.page.encoding) : null};
  }
}
