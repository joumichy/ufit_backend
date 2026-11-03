import type {IdentityAccess} from '../../identity/domain/user.types';
import type {DistributionBrandQuery, DistributionBrands, DistributionChange, DistributionDocument, DistributionHistory,
  DistributionPageQuery, DistributionRevision} from './payment-distribution';

export interface DistributionChangeReceipt {
  revision: DistributionRevision; actorId: string | null; requestHash: string;
}
export interface PaymentDistributionRepository {
  transaction<T>(write: boolean, operation: (repository: PaymentDistributionRepository) => Promise<T>): Promise<T>;
  access(actorId: string, write: boolean): Promise<IdentityAccess | undefined>;
  brands(query: DistributionBrandQuery): Promise<DistributionBrands>;
  document(brandId: string, lock: boolean): Promise<DistributionDocument | undefined>;
  history(brandId: string, query: DistributionPageQuery): Promise<DistributionHistory>;
  change(requestId: string): Promise<DistributionChangeReceipt | undefined>;
  revise(brandId: string, actorId: string, requestHash: string, input: DistributionChange, current: DistributionRevision | null): Promise<DistributionRevision>;
  assertOrderTerms(orderId: string): Promise<void>;
}
