import type {IdentityAccess} from './user.types';
import type {
  ChangeUserAdminAccess, ChangeUserStatus, UserAccessChange, UserAccessHistoryQuery,
  UserAdministrationPage, UserAdministrationQuery, UserAdministrationRecord,
} from './user-administration.contract';

export type UserAdministrationState = Omit<UserAdministrationRecord, 'actions'>;
export interface UserAdministrationRepository {
  transaction<T>(write: boolean, operation: (repository: UserAdministrationRepository) => Promise<T>): Promise<T>;
  findAccess(actorId: string, lock: boolean): Promise<IdentityAccess | undefined>;
  lockIdentities(actorId: string, targetId: string): Promise<boolean>;
  list(query: UserAdministrationQuery): Promise<UserAdministrationPage<UserAdministrationState>>;
  current(userId: string, lock: boolean): Promise<UserAdministrationState | undefined>;
  history(userId: string, query: UserAccessHistoryQuery): Promise<UserAdministrationPage<UserAccessChange>>;
  changeStatus(current: UserAdministrationState, input: ChangeUserStatus, actorId: string): Promise<UserAdministrationState>;
  changeAdminAccess(current: UserAdministrationState, input: ChangeUserAdminAccess, actorId: string): Promise<UserAdministrationState>;
}
