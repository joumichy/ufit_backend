import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getEnv } from "../src/config/env";
import { DatabaseService } from "../src/shared/infrastructure/database/database.service";
import { connectAccounts } from "../src/shared/infrastructure/database/schema";
import { DrizzleConnectAccountsRepository } from "../src/modules/payments/infrastructure/drizzle-connect-accounts.repository";
import { CONNECT } from "../src/modules/payments/domain/connect-account";
const fixture = {
  registry: homedir() + "/.codex/private/ufit/qualification.credentials.json",
  country: "US",
  changedCountry: "CH",
  stripePrefix: "acct_qualification_",
  uniqueViolation: "23505",
  checkViolation: "23514",
  zero: 0,
} as const;
const env = getEnv();
if (
  env.NODE_ENV !== "development" ||
  !env.STRIPE_SECRET_KEY?.startsWith("sk_test_")
)
  throw new Error("Selected development TEST profile required");
const registry = JSON.parse(await readFile(fixture.registry, "utf8"));
const database = new DatabaseService();
class VerificationRollback extends Error {}
let passed = fixture.zero as number;
let transientID: string | undefined;
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
try {
  try {
    await database.db.transaction(async (tx) => {
      const repository = new DrizzleConnectAccountsRepository({
        db: tx,
      } as unknown as DatabaseService);
      const scope = {
        kind: CONNECT.kind.brand,
        profileId: registry.brand.profileId,
      };
      const initial = await repository.begin(scope, fixture.country, false);
      const same = await repository.begin(scope, fixture.country, false);
      assert(
        initial.id === same.id,
        "Same beneficiary received two account records",
      );
      passed++;
      let changed = false;
      try {
        await repository.begin(scope, fixture.changedCountry, false);
      } catch (error) {
        changed =
          (error as { response?: { code?: string } }).response?.code ===
          CONNECT.failure.countryChanged.code;
      }
      assert(changed, "Country was silently changed");
      passed++;
      const otherMode = await repository.begin(scope, fixture.country, true);
      transientID = otherMode.id;
      assert(
        otherMode.id !== initial.id && otherMode.stripeAccountId === null,
        "TEST and live associations were mixed",
      );
      const attached = await repository.attach(
        otherMode,
        fixture.stripePrefix + randomUUID(),
      );
      assert(
        (await repository.find(scope, true))?.stripeAccountId ===
          attached.stripeAccountId &&
          (await repository.find(scope, false))?.stripeAccountId ===
            initial.stripeAccountId,
        "Account attachment crossed modes",
      );
      passed++;
      async function rejectsInsert(
        input: typeof connectAccounts.$inferInsert,
        code: string,
      ) {
        let rejected = false;
        try {
          await tx.transaction(async (nested) => {
            await nested.insert(connectAccounts).values(input);
          });
        } catch (error) {
          rejected =
            (error as { cause?: { code?: string } }).cause?.code === code;
        }
        assert(
          rejected,
          "Required Connect persistence constraint was not enforced",
        );
      }
      await rejectsInsert(
        {
          brandId: registry.brand.profileId,
          creatorId: registry.creator.profileId,
          country: fixture.country,
          liveMode: false,
        },
        fixture.checkViolation,
      );
      await rejectsInsert(
        { country: fixture.country, liveMode: false },
        fixture.checkViolation,
      );
      await rejectsInsert(
        {
          brandId: registry.brand.profileId,
          country: fixture.country,
          liveMode: false,
        },
        fixture.uniqueViolation,
      );
      passed++;
      throw new VerificationRollback();
    });
  } catch (error) {
    if (!(error instanceof VerificationRollback)) throw error;
  }
  assert(transientID, "Verification did not execute");
  const rows = await database.db
    .select()
    .from(connectAccounts)
    .where(eq(connectAccounts.id, transientID));
  assert(rows.length === fixture.zero, "Verification rows were persisted");
  console.log(
    JSON.stringify({
      repositoryScenarios: passed,
      persistedQualificationRows: rows.length,
      checks: [
        "unique beneficiary",
        "country immutable",
        "TEST/live separated",
        "exclusive owner constraints",
      ],
    }),
  );
} finally {
  await database.onModuleDestroy();
}
