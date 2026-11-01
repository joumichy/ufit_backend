import type {IdentityAccess} from '../../identity/domain/user.types';
import type {CommissionRulePage, CommissionRuleQuery, CommissionRuleRevision, CreateCommissionRule, ReviseCommissionRule} from './commission-rule.contract';
import type {CommissionOptionKind, CommissionOptionQuery, CommissionOptionPage} from './commission-rule-options.contract';

export interface CommissionRuleRepository {
  transaction<T>(write: boolean, operation: (repository: CommissionRuleRepository) => Promise<T>): Promise<T>;
  findAccess(actorId: string, write: boolean): Promise<IdentityAccess | undefined>;
  options(kind: CommissionOptionKind, query: CommissionOptionQuery): Promise<CommissionOptionPage>;
  referencesExist(input: Pick<CreateCommissionRule, 'brandId' | 'productId' | 'creatorGradeCode'>): Promise<boolean>;
  list(query: CommissionRuleQuery, scopeId?: string): Promise<CommissionRulePage>;
  current(scopeId: string, lock: boolean): Promise<CommissionRuleRevision | undefined>;
  create(input: CreateCommissionRule, actorId: string): Promise<CommissionRuleRevision | undefined>;
  revise(current: CommissionRuleRevision, input: ReviseCommissionRule, actorId: string): Promise<CommissionRuleRevision>;
}
