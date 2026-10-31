import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "./schema";

// Repositories can share an existing transaction without opening another connection.
export interface DatabaseSession {
  readonly db: Pick<NodePgDatabase<typeof schema>, "select" | "insert" | "update" | "delete" | "execute" | "query">;
}
