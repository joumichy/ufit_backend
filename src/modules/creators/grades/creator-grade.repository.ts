import type {IdentityAccess} from '../../identity/domain/user.types';
import type {
  ChangeCreatorGrade, CreateCreatorGrade, CreatorGradeAssignment, CreatorGradeAssignmentQuery,
  CreatorGradeChange, CreatorGradeChangeResult, CreatorGradeDefinition, CreatorGradeHistoryQuery,
  CreatorGradePage, CreatorGradeQuery, CreatorGradeRevision, ReviseCreatorGrade,
} from './creator-grade.contract';

export interface CreatorGradeAssignmentState {assignment: CreatorGradeAssignment; userId: string;}

export interface CreatorGradeRepository {
  transaction<T>(write: boolean, operation: (repository: CreatorGradeRepository) => Promise<T>): Promise<T>;
  findAccess(actorId: string, write: boolean): Promise<IdentityAccess | undefined>;
  list(query: CreatorGradeQuery): Promise<CreatorGradePage<CreatorGradeDefinition>>;
  current(code: string, lock: boolean): Promise<CreatorGradeDefinition | undefined>;
  history(code: string, query: CreatorGradeHistoryQuery): Promise<CreatorGradePage<CreatorGradeRevision>>;
  create(input: CreateCreatorGrade, actorId: string): Promise<CreatorGradeDefinition | undefined>;
  revise(current: CreatorGradeDefinition, input: ReviseCreatorGrade, actorId: string): Promise<CreatorGradeDefinition>;
  assignments(query: CreatorGradeAssignmentQuery): Promise<CreatorGradePage<CreatorGradeAssignment>>;
  lockAssignmentIdentities(actorId: string, creatorId: string): Promise<string | undefined>;
  currentAssignment(creatorId: string, lock: boolean): Promise<CreatorGradeAssignmentState | undefined>;
  assignmentHistory(creatorId: string, query: CreatorGradeHistoryQuery): Promise<CreatorGradePage<CreatorGradeChange>>;
  change(current: CreatorGradeAssignmentState, target: CreatorGradeDefinition, input: ChangeCreatorGrade, actorId: string): Promise<CreatorGradeChangeResult>;
}
