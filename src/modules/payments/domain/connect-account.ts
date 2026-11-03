export const CONNECT = {
  repository: Symbol("ConnectAccountsRepository"),
  kind: { brand: "brand", creator: "creator" },
  stage: {
    notStarted: "not_started",
    incomplete: "incomplete",
    verifying: "pending_verification",
    restricted: "restricted",
    ready: "ready",
  },
  profileActive: "active",
  ownerRole: "owner",
  capabilityActive: "active",
  capabilityPending: "pending",
  accountType: "express",
  creation: {
    serviceAgreement: "full",
    idempotencyPrefix: "ufit-connect-account:full-card-transfers:",
  },
  linkType: "account_onboarding",
  collectionFields: "eventually_due",
  metadata: {
    associationId: "ufit_connect_id",
    profileId: "ufit_profile_id",
    kind: "ufit_profile_kind",
  },
  eventUpdated: "account.updated",
  countryPattern: /^[A-Z]{2}$/,
  pageLimit: 100,
  singleRow: 1,
  zero: 0,
  key: { test: ["sk_test_", "rk_test_"], live: ["sk_live_", "rk_live_"] },
  callback: {
    returnPath: "/payments/connect/return",
    refreshPath: "/payments/connect/refresh",
    appReturn: "ufit://connect/return",
    appRefresh: "ufit://connect/refresh",
    redirect: 303,
    secure: "https:",
  },
  provider: {
    invalidRequest: "StripeInvalidRequestError",
    activationCode: "account_create_activation_required",
    signupMessage: "signed up for Connect",
    platformMessage: "Only Stripe Connect platforms",
  },
  route: {
    dashboard: ":kind/:profileId/dashboard",
    base: "payments/connect",
    countries: "countries",
    status: ":kind/:profileId",
    onboarding: ":kind/:profileId/onboarding",
    returned: "return",
    refresh: "refresh",
    kindParam: "kind",
    profileParam: "profileId",
  },
  failure: {
    platformSetup: {
      code: "connect_platform_setup_required",
      message:
        "The platform must enable Stripe Connect before onboarding recipients",
    },
    unavailable: {
      code: "connect_unavailable",
      message: "Stripe Connect is not configured",
    },
    scope: {
      code: "connect_scope_unavailable",
      message: "The payment profile is not available to this account",
    },
    owner: {
      code: "connect_owner_required",
      message: "Only the profile owner can configure Stripe Connect",
    },
    country: {
      code: "connect_country_invalid",
      message: "Choose a supported establishment country",
    },
    countryChanged: {
      code: "connect_country_immutable",
      message: "The connected account country cannot be changed",
    },
    mismatch: {
      code: "connect_account_mismatch",
      message: "Stripe returned an account for another payment profile",
    },
    sale: {
      code: "connect_recipient_incomplete",
      message: "A sale recipient must complete Stripe Connect first",
    },
    origin: {
      code: "connect_callback_unavailable",
      message: "The Stripe Connect callback origin is not configured",
    },
  },
} as const;
export type ConnectKind = (typeof CONNECT.kind)[keyof typeof CONNECT.kind];
export interface ConnectScope {
  kind: ConnectKind;
  profileId: string;
}
export interface ConnectSnapshot {
  stage: (typeof CONNECT.stage)[keyof typeof CONNECT.stage];
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  transfersEnabled: boolean;
  missingInformationCount: number;
  pendingVerificationCount: number;
}
export interface ConnectAccountRecord extends ConnectScope {
  id: string;
  country: string;
  liveMode: boolean;
  stripeAccountId: string | null;
  snapshot: ConnectSnapshot | null;
}
export interface ConnectAccountStatus extends ConnectScope, ConnectSnapshot {
  country: string | null;
  liveMode: boolean;
  canConfigure: boolean;
}
export interface ConnectAccountsRepository {
  find(
    scope: ConnectScope,
    liveMode: boolean,
  ): Promise<ConnectAccountRecord | null>;
  begin(
    scope: ConnectScope,
    country: string,
    liveMode: boolean,
  ): Promise<ConnectAccountRecord>;
  attach(
    record: ConnectAccountRecord,
    stripeAccountId: string,
  ): Promise<ConnectAccountRecord>;
  saveSnapshot(
    record: ConnectAccountRecord,
    snapshot: ConnectSnapshot,
  ): Promise<void>;
  findByStripeId(
    stripeAccountId: string,
    liveMode: boolean,
  ): Promise<ConnectAccountRecord | null>;
}
export function emptyConnectSnapshot(
  stage: ConnectSnapshot["stage"],
): ConnectSnapshot {
  return {
    stage,
    chargesEnabled: false,
    payoutsEnabled: false,
    transfersEnabled: false,
    missingInformationCount: CONNECT.zero,
    pendingVerificationCount: CONNECT.zero,
  };
}
export const connectCreationKey = (id: string) => CONNECT.creation.idempotencyPrefix + id;
