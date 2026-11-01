import {BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException} from '@nestjs/common';
import {z} from 'zod';
import type {IdentityAccess} from '../../identity/domain/user.types';
import type {CreatorGradeRepository} from './creator-grade.repository';
import {
  CREATOR_GRADE, changeCreatorGradeSchema, createCreatorGradeSchema, creatorGradeAssignmentPageSchema,
  creatorGradeCodeSchema, creatorGradeHistoryPageSchema, creatorGradePageSchema, reviseCreatorGradeSchema,
} from './creator-grade.contract';

@Injectable()
export class CreatorGradesService {
  constructor(@Inject(CREATOR_GRADE.token.repository) private readonly grades: CreatorGradeRepository) {}

  list(actorId: string, query: unknown) {
    const page = parse(creatorGradePageSchema, query);
    return this.authorized(actorId, false, repository => repository.list(page));
  }

  current(actorId: string, code: string) {
    const identifier = parse(creatorGradeCodeSchema, code);
    return this.authorized(actorId, false, repository => requireGrade(repository, identifier, false));
  }

  history(actorId: string, code: string, query: unknown) {
    const identifier = parse(creatorGradeCodeSchema, code), page = parse(creatorGradeHistoryPageSchema, query);
    return this.authorized(actorId, false, async repository => {
      await requireGrade(repository, identifier, false);
      return repository.history(identifier, page);
    });
  }

  create(actorId: string, input: unknown) {
    const proposal = parse(createCreatorGradeSchema, input);
    return this.authorized(actorId, true, async repository => {
      const result = await repository.create(proposal, actorId);
      if (!result) throw new ConflictException(CREATOR_GRADE.failure.occupied);
      return result;
    });
  }

  revise(actorId: string, code: string, input: unknown) {
    const identifier = parse(creatorGradeCodeSchema, code), proposal = parse(reviseCreatorGradeSchema, input);
    return this.authorized(actorId, true, async repository => {
      const current = await requireGrade(repository, identifier, true);
      if (current.version !== proposal.expectedVersion) throw new ConflictException(CREATOR_GRADE.failure.changed);
      if (current.version === CREATOR_GRADE.limits.maximumInteger) throw new ConflictException(CREATOR_GRADE.failure.versionLimit);
      if (current.isInitial && !proposal.assignable) throw new ConflictException(CREATOR_GRADE.failure.initial);
      return repository.revise(current, proposal, actorId);
    });
  }

  assignments(actorId: string, query: unknown) {
    const page = parse(creatorGradeAssignmentPageSchema, query);
    return this.authorized(actorId, false, repository => repository.assignments(page));
  }

  assignment(actorId: string, creatorId: string) {
    const identifier = parse(z.uuid(), creatorId);
    return this.authorized(actorId, false, async repository => (await requireAssignment(repository, identifier, false)).assignment);
  }

  assignmentHistory(actorId: string, creatorId: string, query: unknown) {
    const identifier = parse(z.uuid(), creatorId), page = parse(creatorGradeHistoryPageSchema, query);
    return this.authorized(actorId, false, async repository => {
      await requireAssignment(repository, identifier, false);
      return repository.assignmentHistory(identifier, page);
    });
  }

  change(actorId: string, creatorId: string, input: unknown) {
    const identifier = parse(z.uuid(), creatorId), proposal = parse(changeCreatorGradeSchema, input);
    return this.grades.transaction(true, async repository => {
      requireAccess(await repository.findAccess(actorId, false));
      // Lock both identities in a stable order before the profile to avoid opposite-user deadlocks.
      const ownerId = await repository.lockAssignmentIdentities(actorId, identifier);
      if (!ownerId) throw new NotFoundException(CREATOR_GRADE.failure.creatorMissing);
      requireAccess(await repository.findAccess(actorId, true));
      const current = await requireAssignment(repository, identifier, true);
      if (current.userId !== ownerId || current.assignment.version !== proposal.expectedVersion) {
        throw new ConflictException(CREATOR_GRADE.failure.assignmentChanged);
      }
      if (current.assignment.accountStatus !== CREATOR_GRADE.status.activeUser ||
          !CREATOR_GRADE.status.assignableCreator.some(status => status === current.assignment.creatorStatus)) {
        throw new ConflictException(CREATOR_GRADE.failure.unavailableCreator);
      }
      if (current.assignment.version === CREATOR_GRADE.limits.maximumInteger) throw new ConflictException(CREATOR_GRADE.failure.versionLimit);
      const target = await requireGrade(repository, proposal.gradeCode, true);
      if (!target.assignable) throw new ConflictException(CREATOR_GRADE.failure.unavailableGrade);
      if (target.code === current.assignment.gradeCode) throw new ConflictException(CREATOR_GRADE.failure.unchanged);
      return repository.change(current, target, proposal, actorId);
    });
  }

  private authorized<T>(actorId: string, write: boolean, operation: (repository: CreatorGradeRepository) => Promise<T>): Promise<T> {
    return this.grades.transaction(write, async repository => {
      requireAccess(await repository.findAccess(actorId, write));
      return operation(repository);
    });
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException(CREATOR_GRADE.failure.input);
  return result.data;
}
function requireAccess(access: IdentityAccess | undefined) {
  if (!access || access.status !== CREATOR_GRADE.status.activeUser || !CREATOR_GRADE.roles.some(role => access.roles.includes(role))) {
    throw new ForbiddenException(CREATOR_GRADE.failure.access);
  }
}
async function requireGrade(repository: CreatorGradeRepository, code: string, lock: boolean) {
  const result = await repository.current(code, lock);
  if (!result) throw new NotFoundException(CREATOR_GRADE.failure.missing);
  return result;
}
async function requireAssignment(repository: CreatorGradeRepository, creatorId: string, lock: boolean) {
  const result = await repository.currentAssignment(creatorId, lock);
  if (!result) throw new NotFoundException(CREATOR_GRADE.failure.creatorMissing);
  return result;
}
