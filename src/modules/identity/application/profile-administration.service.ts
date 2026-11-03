import {BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException} from '@nestjs/common';
import {z} from 'zod';
import {PROFILE_STATUS} from '../../../shared/domain/profile-editing.contract';
import {isUserAdministrator} from '../domain/user-administration.policy';
import {USER_ADMINISTRATION, userAdministrationIdentifierSchema} from '../domain/user-administration.contract';
import {PROFILE_ADMINISTRATION as P, changeProfileStatusSchema, profileAdministrationActions, profileAdministrationKindSchema, profileAdministrationPageSchema, type AdministeredProfileState} from '../domain/profile-administration.contract';
import type {ProfileAdministrationRepository} from '../domain/profile-administration.repository';

@Injectable()
export class ProfileAdministrationService {
  constructor(@Inject(P.token.repository) private readonly profiles: ProfileAdministrationRepository) {}
  list(actorId: string, userId: string, kind: string, query: unknown) {
    const user = parse(userAdministrationIdentifierSchema, userId), scope = parse(profileAdministrationKindSchema, kind), page = parse(profileAdministrationPageSchema, query);
    return this.authorized(actorId, async repository => {
      const result = await repository.list(user, scope, page);
      return {...result, items: result.items.map(project)};
    });
  }
  current(actorId: string, userId: string, kind: string, profileId: string) {
    const scope = identifiers(userId, kind, profileId);
    return this.authorized(actorId, async repository => project(await requireProfile(repository, scope, false)));
  }
  history(actorId: string, userId: string, kind: string, profileId: string, query: unknown) {
    const scope = identifiers(userId, kind, profileId), page = parse(profileAdministrationPageSchema, query);
    return this.authorized(actorId, async repository => {
      await requireProfile(repository, scope, false);
      return repository.history(scope.kind, scope.profileId, page);
    });
  }
  change(actorId: string, userId: string, kind: string, profileId: string, input: unknown) {
    const scope = identifiers(userId, kind, profileId), proposal = parse(changeProfileStatusSchema, input);
    return this.profiles.transaction(true, async repository => {
      requireAdministrator(await repository.findAccess(actorId, false));
      if (!await repository.lockIdentities(actorId, scope.userId)) throw new NotFoundException(P.failure.missing);
      requireAdministrator(await repository.findAccess(actorId, true));
      const current = await requireProfile(repository, scope, true);
      if (current.version !== proposal.expectedVersion) throw new ConflictException(P.failure.changed);
      const actions = profileAdministrationActions(current);
      const allowed = proposal.status === PROFILE_STATUS.suspended ? actions.suspend : proposal.status === PROFILE_STATUS.active ? actions.activate : actions.pause;
      if (!allowed) throw new ConflictException(P.failure.unavailable);
      return project(await repository.change(current, proposal, actorId));
    });
  }
  private authorized<T>(actorId: string, operation: (repository: ProfileAdministrationRepository) => Promise<T>) {
    return this.profiles.transaction(false, async repository => {
      requireAdministrator(await repository.findAccess(actorId, false));
      return operation(repository);
    });
  }
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new BadRequestException(P.failure.input);
  return result.data;
}
function identifiers(userId: string, kind: string, profileId: string) {
  return {userId: parse(userAdministrationIdentifierSchema, userId), kind: parse(profileAdministrationKindSchema, kind), profileId: parse(userAdministrationIdentifierSchema, profileId)};
}
async function requireProfile(repository: ProfileAdministrationRepository, scope: ReturnType<typeof identifiers>, lock: boolean) {
  const value = await repository.current(scope.userId, scope.kind, scope.profileId, lock);
  if (!value) throw new NotFoundException(P.failure.missing);
  return value;
}
function requireAdministrator(actor: Awaited<ReturnType<ProfileAdministrationRepository['findAccess']>>) {
  if (!isUserAdministrator(actor)) throw new ForbiddenException(USER_ADMINISTRATION.failure.access);
}
function project(profile: AdministeredProfileState) {
  const {hasActiveOperator: _, ...value} = profile;
  return {...value, actions: profileAdministrationActions(profile)};
}
