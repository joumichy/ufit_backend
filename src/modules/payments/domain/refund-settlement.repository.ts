import type {IdentityAccess} from '../../identity/domain/user.types';
import type {RefundSource, RefundDocument, RefundReservation, RefundReadResult} from './refund-settlement';

export interface RefundSettlementRepository {
  transaction<T>(write: boolean, operation: (repository: RefundSettlementRepository) => Promise<T>): Promise<T>;
  access(actorId: string, write: boolean): Promise<IdentityAccess | undefined>;
  source(paymentId: string): Promise<RefundSource | undefined>;
  request(paymentId: string): Promise<void>;
  requestCharge(chargeId: string, liveMode: boolean): Promise<boolean>;
  document(paymentId: string): Promise<RefundDocument | undefined>;
  claim(): Promise<RefundReservation[]>;
  finish(claim: RefundReservation, result: RefundReadResult): Promise<boolean>;
}
