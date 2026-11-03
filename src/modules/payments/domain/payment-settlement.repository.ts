import type {IdentityAccess} from '../../identity/domain/user.types';
import type {CaptureReadResult, CaptureReservation, PaymentSettlementDocument} from './payment-settlement';

export interface PaymentSettlementRepository {
  transaction<T>(write: boolean, operation: (repository: PaymentSettlementRepository) => Promise<T>): Promise<T>;
  access(actorId: string, write: boolean): Promise<IdentityAccess | undefined>;
  document(paymentId: string): Promise<PaymentSettlementDocument | undefined>;
  enqueue(paymentId: string): Promise<void>;
  claim(): Promise<CaptureReservation[]>;
  finish(claim: CaptureReservation, result: CaptureReadResult): Promise<boolean>;
}
