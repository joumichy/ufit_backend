import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "./schema";

export const READ_SNAPSHOT = {isolationLevel: 'repeatable read', accessMode: 'read only'} as const;

// Repositories can share an existing transaction without opening another connection.
export interface DatabaseSession {
  readonly db: Pick<NodePgDatabase<typeof schema>, "select" | "insert" | "update" | "delete" | "execute" | "query" | "transaction">;
}
