import {
  boolean,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { ufitSchema, timestamps } from "./schema-base";
import { brandProfiles, creatorProfiles } from "./schema";
import type { ConnectSnapshot } from "../../../modules/payments/domain/connect-account";

export const connectAccounts = ufitSchema.table(
  "connect_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brandId: uuid("brand_id").references(() => brandProfiles.id),
    creatorId: uuid("creator_id").references(() => creatorProfiles.id),
    country: text("country").notNull(),
    liveMode: boolean("live_mode").notNull(),
    stripeAccountId: text("stripe_account_id").unique(),
    snapshot: jsonb("snapshot").$type<ConnectSnapshot>(),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    brandMode: uniqueIndex("connect_accounts_brand_mode_unique").on(
      table.brandId,
      table.liveMode,
    ),
    creatorMode: uniqueIndex("connect_accounts_creator_mode_unique").on(
      table.creatorId,
      table.liveMode,
    ),
  }),
);
