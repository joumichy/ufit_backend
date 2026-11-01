import {BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException} from '@nestjs/common';
import {z} from 'zod';
import type {IdentityAccess} from '../domain/user.types';
import type {UserAdministrationRepository, UserAdministrationState} from '../domain/user-administration.repository';
import {isUserAdministrator, userAdministrationActions} from '../domain/user-administration.policy';
import {
  USER_ADMINISTRATION, changeUserAdminAccessSchema, changeUserStatusSchema,
  userAccessHistoryPageSchema, userAdministrationPageSchema, userAdministrationIdentifierSchema,
} from '../domain/user-administration.contract';

@Injectable()
export class UserAdministrationService {
  constructor(@Inject(USER_ADMINISTRATION.token.repository) private readonly users: UserAdministrationRepository) {}

  list(actorId: string, query: unknown) {
    const page = parse(userAdministrationPageSchema, query);
    return this.authorized(actorId, async (repository, actor) => {
      const result = await repository.list(page);
      return {...result, items: result.items.map(user => record(actorId, actor, user))};
    });
  }
  current(actorId: string, userId: string) {
    const targetId = parse(userAdministrationIdentifierSchema, userId);
    return this.authorized(actorId, async (repository, actor) => record(actorId, actor, await requireUser(repository, targetId, false)));
  }
  history(actorId: string, userId: string, query: unknown) {
    const targetId = parse(userAdministrationIdentifierSchema, userId), page = parse(userAccessHistoryPageSchema, query);
    return this.authorized(actorId, async repository => {
      await requireUser(repository, targetId, false);
      return repository.history(targetId, page);
    });
  }
  changeStatus(actorId: string, userId: string, input: unknown) {
    const targetId = parse(userAdministrationIdentifierSchema, userId), proposal = parse(changeUserStatusSchema, input);
    return this.mutate(actorId, targetId, proposal.expectedVersion, async (repository, actor, current) => {
      if (targetId === actorId) throw new ConflictException(USER_ADMINISTRATION.failure.selfStatus);
      if (proposal.status === current.status) throw new ConflictException(USER_ADMINISTRATION.failure.unchanged);
      const actions = userAdministrationActions(actorId, actor, current);
      const allowed = proposal.status === USER_ADMINISTRATION.status.active ? actions.activate : actions.suspend;
      if (!allowed) throw new ForbiddenException(USER_ADMINISTRATION.failure.superAdmin);
      return repository.changeStatus(current, proposal, actorId);
    });
  }
  changeAdminAccess(actorId: string, userId: string, input: unknown) {
    const targetId = parse(userAdministrationIdentifierSchema, userId), proposal = parse(changeUserAdminAccessSchema, input);
    return this.mutate(actorId, targetId, proposal.expectedVersion, async (repository, actor, current) => {
      if (!actor.roles.includes(USER_ADMINISTRATION.role.superAdmin)) throw new ForbiddenException(USER_ADMINISTRATION.failure.superAdmin);
      const actions = userAdministrationActions(actorId, actor, current);
      if (!(proposal.enabled ? actions.grantAdmin : actions.revokeAdmin)) throw new ConflictException(USER_ADMINISTRATION.failure.unchanged);
      return repository.changeAdminAccess(current, proposal, actorId);
    });
  }
  private authorized<T>(actorId: string, operation: (repository: UserAdministrationRepository, actor: IdentityAccess) => Promise<T>) {
    return this.users.transaction(false, async repository => operation(repository, requireAdministrator(await repository.findAccess(actorId, false))));
  }
  private mutate(actorId: string, targetId: string, expectedVersion: number,
    operation: (repository: UserAdministrationRepository, actor: IdentityAccess, current: UserAdministrationState) => Promise<UserAdministrationState>) {
    return this.users.transaction(true, async repository => {
      requireAdministrator(await repository.findAccess(actorId, false));
      if (!(await repository.lockIdentities(actorId, targetId))) throw new NotFoundException(USER_ADMINISTRATION.failure.missing);
      const actor = requireAdministrator(await repository.findAccess(actorId, true));
      const current = await requireUser(repository, targetId, true);
      if (current.version !== expectedVersion) throw new ConflictException(USER_ADMINISTRATION.failure.changed);
      if (current.version === USER_ADMINISTRATION.limits.maximumVersion) throw new ConflictException(USER_ADMINISTRATION.failure.versionLimit);
      if (current.status === USER_ADMINISTRATION.status.deleted) throw new ConflictException(USER_ADMINISTRATION.failure.deleted);
      return record(actorId, actor, await operation(repository, actor, current));
    });
  }
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new BadRequestException(USER_ADMINISTRATION.failure.input);
  return result.data;
}
function requireAdministrator(actor: IdentityAccess | undefined): IdentityAccess {
  if (!isUserAdministrator(actor)) throw new ForbiddenException(USER_ADMINISTRATION.failure.access);
  return actor;
}
async function requireUser(repository: UserAdministrationRepository, userId: string, lock: boolean) {
  const result = await repository.current(userId, lock);
  if (!result) throw new NotFoundException(USER_ADMINISTRATION.failure.missing);
  return result;
}
function record(actorId: string, actor: IdentityAccess, user: UserAdministrationState) {
  return {...user, actions: userAdministrationActions(actorId, actor, user)};
}
