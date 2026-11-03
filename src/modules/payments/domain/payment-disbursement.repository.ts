import type {CommissionRelease} from '../../commissions/domain/commission-release';
import type {StoredAllocationPlan} from './payment-allocation';
import type {DisbursementAssessment, DisbursementBasis} from './payment-disbursement';
import type {ConnectAccountRecord} from './connect-account';
import type {TransferReason, TransferInstruction, ReversalInstruction, TransferSnapshot, ReversalSnapshot} from './payment-transfer';

export interface DisbursementAvailability {
  key: string; releaseState: CommissionRelease['state'] | null; allowed: boolean; reason: TransferReason | null; availableAt: string | null; account: ConnectAccountRecord | null;
}
export interface DisbursementContext {
  plan: StoredAllocationPlan; basis: DisbursementBasis; assessment: DisbursementAssessment; availability: DisbursementAvailability[];
}
export const DISBURSEMENT_EXECUTION = {
  repository: Symbol('DisbursementExecutionRepository'),
  operation: {transfer: 'transfer', reversal: 'reversal'},
  state: {queued: 'queued', processing: 'processing', waiting: 'waiting', review: 'needs_review'},
  operationState: {open: 'open', recorded: 'recorded', superseded: 'superseded'},
  decision: {idle: 'idle', hold: 'hold', review: 'review', transfer: 'transfer', reversal: 'reversal'},
  reason: {ledger: 'disbursement_ledger_invalid', absent: 'disbursement_allocation_unavailable',
    unavailable: 'disbursement_execution_unavailable', completed: 'disbursement_current'},
  limits: {zero: 0, one: 1, batch: 2, leaseMs: 120_000, retryMs: 30_000, recheckMs: 900_000},
  lock: 'update', digest: {algorithm: 'sha256', encoding: 'hex'},
} as const;
export interface DisbursementTransfer {
  instruction: TransferInstruction; snapshot: TransferSnapshot; reversals: ReversalSnapshot[];
}
export type DisbursementOperation = {kind: typeof DISBURSEMENT_EXECUTION.operation.transfer; instruction: TransferInstruction}
  | {kind: typeof DISBURSEMENT_EXECUTION.operation.reversal; instruction: ReversalInstruction};
export interface DisbursementLease {paymentId: string; token: string;}
export interface StoredDisbursementOperation {id: string; armed: boolean; operation: DisbursementOperation;}
export interface DisbursementExecutionSession {
  context: DisbursementContext | null;
  failure: string | null;
  open: StoredDisbursementOperation | null;
  ledger(): Promise<DisbursementTransfer[]>;
  refreshContext(): Promise<DisbursementContext | null>;
  rememberAssessment(assessment: DisbursementAssessment): Promise<string | undefined>;
  stage(operation: DisbursementOperation, assessment: DisbursementAssessment): Promise<void>;
  record(operation: StoredDisbursementOperation, snapshot: TransferSnapshot | ReversalSnapshot): Promise<void>;
  arm(operationId: string): Promise<void>;
  supersede(operationId: string): Promise<void>;
  requestRefundRead(): Promise<void>;
  markPaid(commissionIds: string[]): Promise<void>;
  finish(state: typeof DISBURSEMENT_EXECUTION.state[keyof typeof DISBURSEMENT_EXECUTION.state], reason: string | null, delay: number): Promise<void>;
}
export interface DisbursementExecutionRepository {
  discover(): Promise<void>;
  claim(): Promise<DisbursementLease[]>;
  withLease<T>(lease: DisbursementLease, operation: (session: DisbursementExecutionSession) => Promise<T>): Promise<T | undefined>;
}
