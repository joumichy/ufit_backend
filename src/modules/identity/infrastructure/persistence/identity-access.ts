import {eq} from 'drizzle-orm';
import type {DatabaseSession} from '../../../../shared/infrastructure/database/database-session';
import {users, userRoles} from '../../../../shared/infrastructure/database/schema';
import type {IdentityAccess} from '../../domain/user.types';

export enum IdentityAccessMode {Read, Lock}
const IDENTITY_ACCESS = {rowLock: 'update', singleRow: 1} as const;
export async function findIdentityAccess(database: DatabaseSession, actorId: string, mode: IdentityAccessMode): Promise<IdentityAccess | undefined> {
  const actorQuery = database.db.select({status: users.status}).from(users).where(eq(users.id, actorId)).limit(IDENTITY_ACCESS.singleRow);
  const [actor] = mode === IdentityAccessMode.Lock ? await actorQuery.for(IDENTITY_ACCESS.rowLock) : await actorQuery;
  if (!actor) return undefined;
  const rolesQuery = database.db.select({role: userRoles.role}).from(userRoles).where(eq(userRoles.userId, actorId)).orderBy(userRoles.role);
  const roles = mode === IdentityAccessMode.Lock ? await rolesQuery.for(IDENTITY_ACCESS.rowLock) : await rolesQuery;
  return {status: actor.status, roles: roles.map(row => row.role)};
}
