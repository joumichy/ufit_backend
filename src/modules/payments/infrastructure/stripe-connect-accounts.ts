import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import type { StripePaymentsClient } from "../application/payments.service";
import {
  CONNECT,
  connectCreationKey,
  type ConnectAccountRecord,
  type ConnectSnapshot,
} from "../domain/connect-account";
type StripeAccount = Omit<
  Awaited<ReturnType<StripePaymentsClient["accounts"]["retrieve"]>>,
  "lastResponse"
>;

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
  const missing = new Set([
    ...(account.requirements?.currently_due ?? []),
    ...(account.requirements?.past_due ?? []),
  ]);
  const pending =
    account.requirements?.pending_verification?.length ?? CONNECT.zero;
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
    capabilities: { transfers: { requested: true } },
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
