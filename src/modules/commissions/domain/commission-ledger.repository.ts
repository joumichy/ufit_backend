import type {IdentityAccess} from '../../identity/domain/user.types';
import type {CommissionEntry} from './commission-entry.contract';
import type {CommissionFinancialScope} from './commission-release';
import type {CommissionLedgerQuery,CommissionCursorQuery,CommissionLedgerPage,CommissionLedgerDetail,CommissionRelatedReturn} from './commission-ledger.contract';
export interface CommissionLedgerRepository{
  snapshot<T>(operation:(repository:CommissionLedgerRepository)=>Promise<T>):Promise<T>;
  access(actorId:string):Promise<IdentityAccess|undefined>;
  creatorIdForUser(actorId:string):Promise<string|undefined>;
  page(scope:CommissionFinancialScope,query:CommissionLedgerQuery):Promise<CommissionLedgerPage<CommissionEntry>>;
  detail(id:string):Promise<CommissionLedgerDetail|undefined>;
  relatedReturns(id:string,query:CommissionCursorQuery):Promise<CommissionLedgerPage<CommissionRelatedReturn>>;
}
