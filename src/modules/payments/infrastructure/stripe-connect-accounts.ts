import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import type { StripePaymentsClient } from "../application/payments.service";
import {
  CONNECT,
  connectCreationKey,
  type ConnectAccountRecord,
  type ConnectSnapshot,
  type ConnectRequirements,
  type ConnectRequirementCategory,
} from "../domain/connect-account";
type StripeAccount = Omit<
  Awaited<ReturnType<StripePaymentsClient["accounts"]["retrieve"]>>,
  "lastResponse"
>;
const requirementField = {
  separator: ".",
  bankAccount: "external_account",
  agreement: "tos_acceptance",
  documents: new Set(["document", "additional_document", "proof_of_liveness", "proof_of_registration", "proof_of_relationship"]),
  personalRoots: new Set(["individual", "representative"]),
  personPrefix: "person_",
  businessRoots: new Set(["company", "business_profile", "relationship", "business_type"]),
};
function missingFields(account: StripeAccount): Set<string> {
  return new Set([
    ...(account.requirements?.currently_due ?? []),
    ...(account.requirements?.past_due ?? []),
  ]);
}
function pendingFields(account: StripeAccount): string[] {
  return account.requirements?.pending_verification ?? [];
}
function requirementCategory(field: string): ConnectRequirementCategory {
  const parts = field.split(requirementField.separator);
  const [root] = parts;
  if (root === requirementField.bankAccount) return CONNECT.requirementCategory.bankAccount;
  if (root === requirementField.agreement) return CONNECT.requirementCategory.serviceAgreement;
  if (parts.some(part => requirementField.documents.has(part))) return CONNECT.requirementCategory.documents;
  if (requirementField.personalRoots.has(root) || root.startsWith(requirementField.personPrefix)) return CONNECT.requirementCategory.personalDetails;
  if (requirementField.businessRoots.has(root)) return CONNECT.requirementCategory.businessDetails;
  return CONNECT.requirementCategory.additionalInformation;
}
function requirementCategories(fields: Iterable<string>): ConnectRequirementCategory[] {
  const categories = new Set(Array.from(fields, requirementCategory));
  return Object.values(CONNECT.requirementCategory).filter(category => categories.has(category));
}
export function connectRequirements(account: StripeAccount): ConnectRequirements {
  // Project the requested fields, never the holder's personal values or opaque Stripe identifiers.
  return { missing: requirementCategories(missingFields(account)), pending: requirementCategories(pendingFields(account)) };
}

export function connectSnapshot(
  account: StripeAccount,
  record: ConnectAccountRecord,
): ConnectSnapshot {
  if (
    account.id !== record.stripeAccountId ||
    account.country !== record.country ||
    account.metadata?.[CONNECT.metadata.associationId] !== record.id
  )
    throw new ConflictException(CONNECT.failure.mismatch);
  const missing = missingFields(account);
  const pending = pendingFields(account).length;
  const transfersEnabled =
    account.capabilities?.transfers === CONNECT.capabilityActive;
  const ready =
    account.details_submitted &&
    transfersEnabled &&
    account.payouts_enabled &&
    missing.size === CONNECT.zero &&
    !account.requirements?.disabled_reason;
  const stage = ready
    ? CONNECT.stage.ready
    : missing.size || !account.details_submitted
      ? CONNECT.stage.incomplete
      : pending || account.capabilities?.transfers === CONNECT.capabilityPending
        ? CONNECT.stage.verifying
        : CONNECT.stage.restricted;
  return {
    stage,
    transfersEnabled,
    chargesEnabled: account.charges_enabled,
    payoutsEnabled: account.payouts_enabled,
    missingInformationCount: missing.size,
    pendingVerificationCount: pending,
  };
}
export async function ensureStripeConnectAccount(
  stripe: StripePaymentsClient,
  record: ConnectAccountRecord,
): Promise<StripeAccount> {
  if (record.stripeAccountId)
    return stripe.accounts.retrieve(record.stripeAccountId);
  // Recover an account created before a process crash, including after Stripe's idempotency retention expires.
  for await (const account of stripe.accounts.list({
    limit: CONNECT.pageLimit,
  })) {
    if (account.metadata?.[CONNECT.metadata.associationId] === record.id)
      return account;
  }
  const params: NonNullable<
    Parameters<StripePaymentsClient["accounts"]["create"]>[0]
  > = {
    type: CONNECT.accountType,
    country: record.country,
    // Full-service Swiss accounts require card_payments alongside transfers;
    // recipient agreements cannot support the selected cross-border Connect flow.
    capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
    tos_acceptance: { service_agreement: CONNECT.creation.serviceAgreement },
    metadata: {
      [CONNECT.metadata.associationId]: record.id,
      [CONNECT.metadata.profileId]: record.profileId,
      [CONNECT.metadata.kind]: record.kind,
    },
  };
  try {
    return await stripe.accounts.create(params, {
      idempotencyKey: connectCreationKey(record.id),
    });
  } catch (error) {
    const provider = error as {
      type?: string;
      code?: string;
      message?: string;
    };
    if (
      provider.code === CONNECT.provider.activationCode ||
      (provider.type === CONNECT.provider.invalidRequest &&
        (provider.message?.includes(CONNECT.provider.signupMessage) ||
          provider.message?.includes(CONNECT.provider.platformMessage)))
    )
      throw new ServiceUnavailableException(CONNECT.failure.platformSetup);
    throw error;
  }
}
