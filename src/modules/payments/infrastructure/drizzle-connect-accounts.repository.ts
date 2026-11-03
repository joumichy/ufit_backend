import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, or } from "drizzle-orm";
import { DatabaseService } from "../../../shared/infrastructure/database/database.service";
import type { DatabaseSession } from "../../../shared/infrastructure/database/database-session";
import { connectAccounts } from "../../../shared/infrastructure/database/schema";
import {
  CONNECT,
  type ConnectAccountRecord,
  type ConnectAccountsRepository,
  type ConnectScope,
  type ConnectSnapshot,
} from "../domain/connect-account";

@Injectable()
export class DrizzleConnectAccountsRepository
  implements ConnectAccountsRepository
{
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseSession,
  ) {}
  private scopePredicate(scope: ConnectScope) {
    return eq(
      scope.kind === CONNECT.kind.brand
        ? connectAccounts.brandId
        : connectAccounts.creatorId,
      scope.profileId,
    );
  }
  async find(
    scope: ConnectScope,
    liveMode: boolean,
  ): Promise<ConnectAccountRecord | null> {
    const [row] = await this.database.db
      .select()
      .from(connectAccounts)
      .where(
        and(this.scopePredicate(scope), eq(connectAccounts.liveMode, liveMode)),
      )
      .limit(CONNECT.singleRow);
    return row ? this.project(row) : null;
  }
  async begin(
    scope: ConnectScope,
    country: string,
    liveMode: boolean,
  ): Promise<ConnectAccountRecord> {
    await this.database.db
      .insert(connectAccounts)
      .values({
        ...(scope.kind === CONNECT.kind.brand
          ? { brandId: scope.profileId }
          : { creatorId: scope.profileId }),
        country,
        liveMode,
      })
      .onConflictDoNothing();
    const row = await this.find(scope, liveMode);
    if (!row || row.country !== country)
      throw new ConflictException(CONNECT.failure.countryChanged);
    return row;
  }
  async attach(
    record: ConnectAccountRecord,
    stripeAccountId: string,
  ): Promise<ConnectAccountRecord> {
    const [row] = await this.database.db
      .update(connectAccounts)
      .set({ stripeAccountId, updatedAt: new Date() })
      .where(
        and(
          eq(connectAccounts.id, record.id),
          or(
            isNull(connectAccounts.stripeAccountId),
            eq(connectAccounts.stripeAccountId, stripeAccountId),
          ),
        ),
      )
      .returning();
    if (!row) throw new ConflictException(CONNECT.failure.mismatch);
    return this.project(row);
  }
  async saveSnapshot(
    record: ConnectAccountRecord,
    snapshot: ConnectSnapshot,
  ): Promise<void> {
    await this.database.db
      .update(connectAccounts)
      .set({ snapshot, syncedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(connectAccounts.id, record.id),
          eq(connectAccounts.stripeAccountId, record.stripeAccountId!),
        ),
      );
  }
  async findByStripeId(
    id: string,
    liveMode: boolean,
  ): Promise<ConnectAccountRecord | null> {
    const [row] = await this.database.db
      .select()
      .from(connectAccounts)
      .where(
        and(
          eq(connectAccounts.stripeAccountId, id),
          eq(connectAccounts.liveMode, liveMode),
        ),
      )
      .limit(CONNECT.singleRow);
    return row ? this.project(row) : null;
  }
  private project(
    row: typeof connectAccounts.$inferSelect,
  ): ConnectAccountRecord {
    return {
      id: row.id,
      kind: row.brandId ? CONNECT.kind.brand : CONNECT.kind.creator,
      profileId: row.brandId ?? row.creatorId!,
      country: row.country,
      liveMode: row.liveMode,
      stripeAccountId: row.stripeAccountId,
      snapshot: row.snapshot,
    };
  }
}
