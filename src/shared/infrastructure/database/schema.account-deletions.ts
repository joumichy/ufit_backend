import {check,index,integer,primaryKey,text,timestamp,uniqueIndex,uuid} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import {ufitSchema} from './schema-base';
import {users} from './schema.identity';
import {ACCOUNT_DELETION as D, type AccountDeletionPhase, type AccountDeletionMediaKind, type AccountDeletionRetry} from '../../../modules/identity/domain/account-deletion.contract';

const values=(items:readonly string[])=>sql.raw(items.map(value=>`'${value}'`).join(', '));
const completed=sql.raw(`'${D.phase.completed}'`);
export const accountDeletions=ufitSchema.table('account_deletions',{
  id:uuid('id').primaryKey(),userId:uuid('user_id').notNull().references(()=>users.id),authUserId:uuid('auth_user_id').notNull(),
  proofHash:text('proof_hash').notNull(),phase:text('phase').$type<AccountDeletionPhase>().notNull(),
  requestedAt:timestamp('requested_at',{withTimezone:true}).notNull(),updatedAt:timestamp('updated_at',{withTimezone:true}).notNull(),
  completedAt:timestamp('completed_at',{withTimezone:true}),nextAttemptAt:timestamp('next_attempt_at',{withTimezone:true}).notNull(),
  attempts:integer('attempts').notNull().default(D.limits.zero),leaseToken:uuid('lease_token'),leaseUntil:timestamp('lease_until',{withTimezone:true}),
  lastFailure:text('last_failure').$type<AccountDeletionRetry>(),
},table=>({
  user:uniqueIndex('account_deletion_user_unique').on(table.userId),
  due:index('account_deletion_due_idx').on(table.nextAttemptAt,table.id).where(sql`${table.phase}<>${completed}`),
  proof:check('account_deletion_proof_valid',sql`${table.proofHash}~${sql.raw(`'${D.crypto.proofSource}'`)}`),
  phase:check('account_deletion_phase_valid',sql`${table.phase} in (${values(Object.values(D.phase))})`),
  attempts:check('account_deletion_attempts_valid',sql`${table.attempts}>=${D.limits.zero}`),
  lease:check('account_deletion_lease_valid',sql`(${table.leaseToken} is null)=(${table.leaseUntil} is null)`),
  completion:check('account_deletion_completion_valid',sql`(${table.phase}=${completed})=(${table.completedAt} is not null)
    and (${table.phase}<>${completed} or (${table.leaseToken} is null and ${table.lastFailure} is null))`),
  chronology:check('account_deletion_chronology_valid',sql`${table.updatedAt}>=${table.requestedAt}
    and (${table.completedAt} is null or ${table.completedAt}>=${table.requestedAt})`),
  failure:check('account_deletion_failure_valid',sql`${table.lastFailure} is null or ${table.lastFailure} in (${values(Object.values(D.retry))})`),
}));
export const accountDeletionMedia=ufitSchema.table('account_deletion_media',{
  requestId:uuid('request_id').notNull().references(()=>accountDeletions.id),assetId:uuid('asset_id').notNull(),
  kind:text('kind').$type<AccountDeletionMediaKind>().notNull(),objectPath:text('object_path').notNull(),
},table=>({
  identity:primaryKey({columns:[table.requestId,table.kind,table.assetId]}),
  kind:check('account_deletion_media_kind_valid',sql`${table.kind} in (${values(Object.values(D.media))})`),
  path:check('account_deletion_media_path_valid',sql`length(${table.objectPath})>${D.limits.zero} and ${table.objectPath}=btrim(${table.objectPath})`),
}));
