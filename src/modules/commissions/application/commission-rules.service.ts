import {BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException} from '@nestjs/common';
import type {z} from 'zod';
import type {CommissionRuleRepository} from '../domain/commission-rule.repository';
import {COMMISSION_RULE, commissionRulePageSchema, createCommissionRuleSchema, reviseCommissionRuleSchema} from '../domain/commission-rule.contract';
import {COMMISSION_OPTIONS, parseCommissionOptions} from '../domain/commission-rule-options.contract';

@Injectable()
export class CommissionRulesService {
  constructor(@Inject(COMMISSION_RULE.token.repository) private readonly rules: CommissionRuleRepository) {}
  options(actorId: string, kind: unknown, input: unknown) {
    let selection: ReturnType<typeof parseCommissionOptions>;
    try {selection = parseCommissionOptions(kind, input);} catch {throw new BadRequestException(COMMISSION_OPTIONS.failure);}
    return this.authorized(actorId, false, repository => repository.options(selection.kind, selection.query));
  }
  list(actorId: string, query: unknown) {
    const page = parse(commissionRulePageSchema, query);
    return this.authorized(actorId, false, repository => repository.list(page));
  }
  current(actorId: string, scopeId: string) {
    return this.authorized(actorId, false, repository => requireCurrent(repository, scopeId, false));
  }
  history(actorId: string, scopeId: string, query: unknown) {
    const page = parse(commissionRulePageSchema, query);
    return this.authorized(actorId, false, async repository => {
      const rule = await requireCurrent(repository, scopeId, false);
      if (page.brandId && page.brandId !== rule.brandId) throw new BadRequestException(COMMISSION_RULE.failure.cursor);
      return repository.list(page, scopeId);
    });
  }
  create(actorId: string, input: unknown) {
    const rule = parse(createCommissionRuleSchema, input);
    return this.authorized(actorId, true, async repository => {
      if (!await repository.referencesExist(rule)) throw new BadRequestException(COMMISSION_RULE.failure.reference);
      const created = await repository.create(rule, actorId);
      if (!created) throw new ConflictException(COMMISSION_RULE.failure.scope);
      return created;
    });
  }
  revise(actorId: string, scopeId: string, input: unknown) {
    const revision = parse(reviseCommissionRuleSchema, input);
    return this.authorized(actorId, true, async repository => {
      const current = await requireCurrent(repository, scopeId, true);
      if (current.revision !== revision.expectedRevision) throw new ConflictException(COMMISSION_RULE.failure.changed);
      return repository.revise(current, revision, actorId);
    });
  }
  private authorized<T>(actorId: string, write: boolean, operation: (repository: CommissionRuleRepository) => Promise<T>): Promise<T> {
    return this.rules.transaction(write, async repository => {
      const access = await repository.findAccess(actorId, write);
      if (!access || access.status !== COMMISSION_RULE.status.activeUser || !COMMISSION_RULE.roles.some(role => access.roles.includes(role))) throw new ForbiddenException(COMMISSION_RULE.failure.access);
      return operation(repository);
    });
  }
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new BadRequestException(COMMISSION_RULE.failure.input);
  return result.data;
}
async function requireCurrent(repository: CommissionRuleRepository, scopeId: string, lock: boolean) {
  const rule = await repository.current(scopeId, lock);
  if (!rule) throw new NotFoundException(COMMISSION_RULE.failure.missing);
  return rule;
}
