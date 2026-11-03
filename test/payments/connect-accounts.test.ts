import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONNECT,
  type ConnectAccountRecord,
} from "../../src/modules/payments/domain/connect-account";
import {
  connectSnapshot,
  ensureStripeConnectAccount,
} from "../../src/modules/payments/infrastructure/stripe-connect-accounts";
import { ConnectAccountsService } from "../../src/modules/payments/application/connect-accounts.service";
import { resetEnvCacheForTests } from "../../src/config/env";
import type { AuthenticatedUser } from "../../src/modules/identity/domain/user.types";
const fixture = {
  record: {
    id: "connect-record",
    kind: CONNECT.kind.brand,
    profileId: "brand",
    country: "US",
    liveMode: false,
    stripeAccountId: "acct_recipient",
    snapshot: null,
  } satisfies ConnectAccountRecord,
  account: {
    id: "acct_recipient",
    country: "US",
    metadata: { ufit_connect_id: "connect-record" },
    details_submitted: true,
    payouts_enabled: true,
    charges_enabled: false,
    capabilities: { transfers: "active" },
    requirements: {
      currently_due: [],
      past_due: [],
      pending_verification: [],
      disabled_reason: null,
    },
  },
};
function snapshot(account = fixture.account) {
  return connectSnapshot(account as never, fixture.record);
}
function client(accounts: unknown[] = []) {
  return {
    accounts: {
      retrieve: vi.fn().mockResolvedValue(fixture.account),
      create: vi.fn().mockResolvedValue(fixture.account),
      list: vi.fn(() =>
        (async function* () {
          for (const account of accounts) yield account;
        })(),
      ),
    },
  };
}
describe("Connect recipient contracts", () => {
  it("requires transfer and payout eligibility rather than direct card charging", () => {
    expect(snapshot().stage).toBe("ready");
    expect(
      snapshot({
        ...fixture.account,
        payouts_enabled: false,
        charges_enabled: true,
      }).stage,
    ).not.toBe("ready");
    expect(
      snapshot({ ...fixture.account, capabilities: { transfers: "pending" } })
        .stage,
    ).toBe("pending_verification");
  });
  it("keeps requested information and Stripe restrictions from becoming eligible sales", () => {
    expect(
      snapshot({
        ...fixture.account,
        requirements: {
          ...fixture.account.requirements,
          currently_due: ["company.tax_id"] as never[],
        },
      }).stage,
    ).toBe("incomplete");
    expect(
      snapshot({
        ...fixture.account,
        requirements: {
          ...fixture.account.requirements,
          disabled_reason: "listed" as never,
        },
      }).stage,
    ).toBe("restricted");
  });
  it("rejects another association or establishment country", () => {
    expect(() => snapshot({ ...fixture.account, country: "CH" })).toThrow();
    expect(() =>
      snapshot({
        ...fixture.account,
        metadata: { ufit_connect_id: "another" },
      }),
    ).toThrow();
  });
  it("recovers an account created before its durable association was attached", async () => {
    const stripe = client([fixture.account]);
    const result = await ensureStripeConnectAccount(stripe as never, {
      ...fixture.record,
      stripeAccountId: null,
    });
    expect(result.id).toBe("acct_recipient");
    expect(stripe.accounts.create).not.toHaveBeenCalled();
  });
  it("creates an Express full-service account with a stable cross-border contract", async () => {
    const stripe = client();
    await ensureStripeConnectAccount(stripe as never, {
      ...fixture.record,
      stripeAccountId: null,
    });
    expect(stripe.accounts.create).toHaveBeenCalledWith(
      {
        type: "express",
        country: "US",
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
        tos_acceptance: { service_agreement: "full" },
        metadata: {
          ufit_connect_id: "connect-record",
          ufit_profile_id: "brand",
          ufit_profile_kind: "brand",
        },
      },
      { idempotencyKey: "ufit-connect-account:full-card-transfers:connect-record" },
    );
  });
  it.each([CONNECT.kind.creator, CONNECT.kind.brand])("requests the required full-service capabilities for a Swiss %s", async kind => {
    const stripe = client();
    await ensureStripeConnectAccount(stripe as never, {
      ...fixture.record, kind, country: "CH", stripeAccountId: null,
    });
    expect(stripe.accounts.create).toHaveBeenCalledWith(expect.objectContaining({
      country: "CH", capabilities: {card_payments: {requested: true}, transfers: {requested: true}},
      tos_acceptance: {service_agreement: "full"},
    }), {idempotencyKey: "ufit-connect-account:full-card-transfers:connect-record"});
  });
  it("retrieves an already attached account without changing its capabilities or agreement", async () => {
    const stripe = client();
    await ensureStripeConnectAccount(stripe as never, fixture.record);
    expect(stripe.accounts.retrieve).toHaveBeenCalledWith("acct_recipient");
    expect(stripe.accounts.list).not.toHaveBeenCalled();
    expect(stripe.accounts.create).not.toHaveBeenCalled();
  });
  it("reports the observed platform prerequisite without marking a recipient ready", async () => {
    const stripe = client();
    stripe.accounts.create.mockRejectedValue({
      type: "StripeInvalidRequestError",
      message:
        "You can only create new accounts if you've signed up for Connect",
    });
    await expect(
      ensureStripeConnectAccount(stripe as never, {
        ...fixture.record,
        stripeAccountId: null,
      }),
    ).rejects.toMatchObject({
      response: { code: "connect_platform_setup_required" },
    });
  });
});

describe("Connect owner permissions", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_DIRECT_CONNECTION_DB_URL:
        "postgres://qualification@localhost/qualification",
      STRIPE_SECRET_KEY: "sk_test_fixture",
    };
    resetEnvCacheForTests();
  });
  afterEach(() => {
    process.env = originalEnv;
    resetEnvCacheForTests();
  });
  const actor: AuthenticatedUser = {
    id: "manager",
    email: "qualification@example.test",
    displayName: null,
    avatarUrl: null,
    status: "active",
    roles: ["brand_manager"],
    createdAt: new Date("2026-10-31T00:00:00Z"),
    updatedAt: new Date("2026-10-31T00:00:00Z"),
  };
  function setup() {
    const accounts = { find: vi.fn().mockResolvedValue(null), begin: vi.fn() };
    const brands = {
      getProfileForMember: vi
        .fn()
        .mockResolvedValue({
          id: "brand",
          ownerUserId: "owner",
          status: "active",
        }),
    };
    const creators = {
      getOwnProfile: vi
        .fn()
        .mockResolvedValue({ id: "own-creator", status: "active" }),
    };
    return {
      accounts,
      brands,
      creators,
      service: new ConnectAccountsService(
        {} as never,
        accounts as never,
        brands as never,
        creators as never,
      ),
    };
  }
  it("lets an active member inspect eligibility without granting financial configuration", async () => {
    const { service, brands } = setup();
    const status = await service.status(
      { kind: CONNECT.kind.brand, profileId: "brand" },
      actor,
    );
    expect(status).toMatchObject({
      canConfigure: false,
      stage: "not_started",
      payoutsEnabled: false,
    });
    expect(brands.getProfileForMember).toHaveBeenCalledWith("brand", "manager");
  });
  it("rejects manager onboarding before account creation", async () => {
    const { service, accounts } = setup();
    await expect(
      service.onboarding(
        { kind: CONNECT.kind.brand, profileId: "brand" },
        actor,
        { country: "US" },
      ),
    ).rejects.toMatchObject({ response: { code: "connect_owner_required" } });
    expect(accounts.begin).not.toHaveBeenCalled();
  });
  it("rejects a creator profile that is not owned by the current user", async () => {
    const { service, accounts } = setup();
    await expect(
      service.status(
        { kind: CONNECT.kind.creator, profileId: "other-creator" },
        actor,
      ),
    ).rejects.toMatchObject({
      response: { code: "connect_scope_unavailable" },
    });
    expect(accounts.find).not.toHaveBeenCalled();
  });
});
