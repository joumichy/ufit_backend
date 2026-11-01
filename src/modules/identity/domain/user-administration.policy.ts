import type {IdentityAccess} from './user.types';
import {USER_ADMINISTRATION, type UserAdministrationActions, type UserAdministrationSubject} from './user-administration.contract';

export function isUserAdministrator(actor: IdentityAccess | undefined): actor is IdentityAccess {
  return actor !== undefined && actor.status === USER_ADMINISTRATION.status.active &&
    (actor.roles.includes(USER_ADMINISTRATION.role.admin) || actor.roles.includes(USER_ADMINISTRATION.role.superAdmin));
}

export function userAdministrationActions(actorId: string, actor: IdentityAccess, subject: UserAdministrationSubject): UserAdministrationActions {
  if (!isUserAdministrator(actor) || subject.version >= USER_ADMINISTRATION.limits.maximumVersion || subject.status === USER_ADMINISTRATION.status.deleted) {
    return {suspend: false, activate: false, grantAdmin: false, revokeAdmin: false};
  }
  const superAdmin = actor.roles.includes(USER_ADMINISTRATION.role.superAdmin);
  const targetAdmin = subject.roles.includes(USER_ADMINISTRATION.role.admin);
  const targetSuperAdmin = subject.roles.includes(USER_ADMINISTRATION.role.superAdmin);
  const statusAllowed = actorId !== subject.id && (superAdmin || (!targetAdmin && !targetSuperAdmin));
  // Self-suspension is excluded. An active super-admin acting on another one therefore preserves an active authority.
  return {
    suspend: statusAllowed && subject.status !== USER_ADMINISTRATION.status.suspended,
    activate: statusAllowed && subject.status !== USER_ADMINISTRATION.status.active,
    grantAdmin: superAdmin && !targetAdmin && !targetSuperAdmin && subject.status === USER_ADMINISTRATION.status.active,
    revokeAdmin: superAdmin && targetAdmin && !targetSuperAdmin,
  };
}
