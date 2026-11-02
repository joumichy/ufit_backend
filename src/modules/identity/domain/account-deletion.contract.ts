import {z} from 'zod';

export const ACCOUNT_DELETION = {
  route: {root: 'account-deletions', id: ':requestId', parameter: 'requestId', proofHeader: 'x-ufit-deletion-key'},
  phase: {purging: 'purging_media', revoking: 'revoking_auth', completed: 'completed'},
  media: {product: 'product', outfit: 'outfit'},
  failure: {
    invalid: {code: 'account_deletion_invalid', message: 'Invalid account deletion command'},
    unavailable: {code: 'account_deletion_unavailable', message: 'Account deletion unavailable'},
    proof: {code: 'account_deletion_credential_invalid', message: 'Account deletion receipt unavailable'},
    changed: {code: 'account_deletion_changed', message: 'Another deletion request already owns this account'},
    authority: {code: 'account_deletion_authority_required', message: 'Account deletion authority is unavailable'},
    lastAdministrator: {code: 'account_deletion_last_administrator', message: 'An active replacement super-administrator is required'},
  },
  retry: {storage: 'storage_unavailable', auth: 'auth_unavailable', apple: 'apple_revocation_required'},
  crypto: {proofSource: '^[0-9a-f]{64}$', algorithm: 'sha256', encoding: 'hex'},
  limits: {zero: 0, one: 1, batch: 100, maximumAttempts: 2_147_483_647, leaseMs: 60_000, retryMs: 60_000},
  persistence: {lock: 'update', administratorFence: 'ufit:account-deletion:administrators', lockSeed: 0},
  validation: {customIssue: 'custom'},
  auth: {appleProvider: 'apple', missingUserCode: 'user_not_found', missingUserStatus: 404, softDelete: false},
} as const;

export const deletionIdentifierSchema = z.uuid().transform(value => value.toLowerCase());
export const deletionProofSchema = z.string().regex(new RegExp(ACCOUNT_DELETION.crypto.proofSource));
export const deletionInputSchema = z.object({confirmed: z.literal(true)}).strict();
export const deletionPhaseSchema = z.enum(Object.values(ACCOUNT_DELETION.phase));
export const deletionMediaKindSchema = z.enum(Object.values(ACCOUNT_DELETION.media));
export const deletionReceiptSchema = z.object({
  requestId: deletionIdentifierSchema,
  phase: deletionPhaseSchema,
  requestedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
}).strict().superRefine((value,context) => {
  if ((value.phase === ACCOUNT_DELETION.phase.completed) !== (value.completedAt !== null) ||
      value.completedAt !== null && Date.parse(value.completedAt) < Date.parse(value.requestedAt)) {
    context.addIssue({code: ACCOUNT_DELETION.validation.customIssue, message: ACCOUNT_DELETION.failure.invalid.message});
  }
});
export type AccountDeletionPhase = z.infer<typeof deletionPhaseSchema>;
export type AccountDeletionReceipt = z.infer<typeof deletionReceiptSchema>;
export type AccountDeletionMediaKind = z.infer<typeof deletionMediaKindSchema>;
export type AccountDeletionRetry = typeof ACCOUNT_DELETION.retry[keyof typeof ACCOUNT_DELETION.retry];

export interface AccountDeletionLease {
  requestId: string;
  userId: string;
  authUserId: string;
  phase: Exclude<AccountDeletionPhase, typeof ACCOUNT_DELETION.phase.completed>;
  token: string;
  expiresAt: Date;
}
export interface AccountDeletionMediaTarget {assetId: string; kind: AccountDeletionMediaKind; objectPath: string;}
export interface AccountDeletionAuthority {erase(authUserId: string): Promise<void>;}
export class AccountDeletionAuthorityFailure extends Error {
  constructor(readonly reason: AccountDeletionRetry) {super(ACCOUNT_DELETION.failure.authority.message);}
}
