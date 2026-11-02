import {sql} from 'drizzle-orm';
import type {AnyPgColumn} from 'drizzle-orm/pg-core';
import {users} from '../../shared/infrastructure/database/schema.identity';
import {USER_ADMINISTRATION} from '../identity/domain/user-administration.contract';
import {APPLICATION} from './types/application-contract';

export function availableApplicant(userId:AnyPgColumn) {
  return sql`exists(select ${APPLICATION.limits.row} from ${users}
    where ${users.id}=${userId} and ${users.status}<>${USER_ADMINISTRATION.status.deleted})`;
}
