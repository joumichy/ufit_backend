import type {IdentityAccess} from '../../identity/domain/user.types';
import type {AllocationDocument, StoredAllocationPlan} from './payment-allocation';

export interface PaymentAllocationRepository {
  transaction<T>(write: boolean, operation: (repository: PaymentAllocationRepository) => Promise<T>): Promise<T>;
  access(actorId: string, write: boolean): Promise<IdentityAccess | undefined>;
  document(paymentId: string): Promise<AllocationDocument | undefined>;
  prepare(paymentId: string): Promise<StoredAllocationPlan | undefined>;
}
