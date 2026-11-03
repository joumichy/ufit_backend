import type {IdentityAccess} from './user.types';
import type {UserAdministrationPage} from './user-administration.contract';
import type {AdministeredProfileKind, AdministeredProfileState, ChangeProfileStatus, ProfileAdministrationQuery, ProfileStatusChange} from './profile-administration.contract';

export interface ProfileAdministrationRepository {
  transaction<T>(write: boolean, operation: (repository: ProfileAdministrationRepository) => Promise<T>): Promise<T>;
  findAccess(actorId: string, lock: boolean): Promise<IdentityAccess | undefined>;
  lockIdentities(actorId: string, userId: string): Promise<boolean>;
  list(userId: string, kind: AdministeredProfileKind, query: ProfileAdministrationQuery): Promise<UserAdministrationPage<AdministeredProfileState>>;
  current(userId: string, kind: AdministeredProfileKind, profileId: string, lock: boolean): Promise<AdministeredProfileState | undefined>;
  history(kind: AdministeredProfileKind, profileId: string, query: ProfileAdministrationQuery): Promise<UserAdministrationPage<ProfileStatusChange>>;
  change(current: AdministeredProfileState, input: ChangeProfileStatus, actorId: string): Promise<AdministeredProfileState>;
}
