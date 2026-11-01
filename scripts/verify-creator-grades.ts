import 'reflect-metadata';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {Pool} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {eq} from 'drizzle-orm';
import {HttpException} from '@nestjs/common';
import {getEnv} from '../src/config/env';
import {buildPgSslConfig} from '../src/shared/infrastructure/database/pg-ssl';
import * as schema from '../src/shared/infrastructure/database/schema';
import {CreatorGradesService} from '../src/modules/creators/grades/creator-grades.service';
import {DrizzleCreatorGradesRepository} from '../src/modules/creators/grades/drizzle-creator-grades.repository';
import {CreatorsService} from '../src/modules/creators/creators.service';
import {DrizzleCreatorsRepository} from '../src/modules/creators/drizzle-creators.repository';

const proof = {
  profile: {node: 'development', port: 4014, schema: 'ufit', stripePrefix: 'sk_test_'},
  registry: homedir() + '/.codex/private/ufit/qualification.credentials.json',
  migration: new URL('../src/shared/infrastructure/database/migrations/0022_creator_grade_administration.sql', 'file://' + __filename),
  migrationFlag: '--with-migration', prefix: 'qualification-grade-', reason: 'Qualification des grades en transaction annulée.',
  label: 'Grade de qualification', revised: 'Grade corrigé', rank: 20, nextRank: 21,
  tables: ['creator_grades','creator_grade_revisions','creator_profiles','creator_grade_history','creator_applications','creator_score_snapshots','commission_rules','order_items','orders','commissions','users','user_roles','schema_migrations'],
  first: 0, one: 1, two: 2, zero: 0, conflict: 409, forbidden: 403, badRequest: 400,
  active: 'active', suspended: 'suspended', accepted: 'accepted',
} as const;

class VerificationRollback extends Error {}

async function verify() {
  const env = getEnv();
  assert(env.NODE_ENV === proof.profile.node && env.API_PORT === proof.profile.port && env.UFIT_DB_SCHEMA === proof.profile.schema && env.STRIPE_SECRET_KEY?.startsWith(proof.profile.stripePrefix));
  const registry = JSON.parse(await readFile(proof.registry, 'utf8'));
  const pool = new Pool({connectionString: env.SUPABASE_DIRECT_CONNECTION_DB_URL, ssl: buildPgSslConfig(env), max: proof.one});
  const client = await pool.connect(), database = drizzle(client, {schema});
  let cases = proof.zero as number;
  const withMigration = process.argv.includes(proof.migrationFlag);
  const tables = proof.tables.filter(table => !(withMigration && table === 'creator_grade_revisions'));
  async function fingerprint(table: string) {
    const {rows} = await client.query('select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,\'[]\')) as digest from ufit.' + table + ' t');
    return rows[proof.first].digest as string;
  }
  const before = new Map<string,string>();
  async function rejected(operation: () => Promise<unknown>, status: number) {
    await assert.rejects(async () => operation(), error => error instanceof HttpException && error.getStatus() === status); cases++;
  }
  async function flush() { await client.query('set constraints all immediate'); await client.query('set constraints all deferred'); }
  try {
    for (const table of tables) before.set(table, await fingerprint(table));
    try {
      await database.transaction(async db => {
      if (withMigration) await client.query(await readFile(proof.migration, 'utf8'));
      const [admin] = await db.select().from(schema.users).where(eq(schema.users.email, registry.admin.email)); assert(admin);
      const [creatorUser] = await db.select().from(schema.users).where(eq(schema.users.email, registry.creator.email)); assert(creatorUser);
      const [customer] = await db.select().from(schema.users).where(eq(schema.users.email, registry.customer.email)); assert(customer);
      const [creator] = await db.select().from(schema.creatorProfiles).where(eq(schema.creatorProfiles.userId, creatorUser.id)); assert(creator);
      const service = new CreatorGradesService(new DrizzleCreatorGradesRepository({db}));
      const proposal = {code: proof.prefix + randomUUID(), label: proof.label, rank: proof.rank, assignable: true, reason: proof.reason};
      await rejected(() => service.create(customer.id, proposal), proof.forbidden);
      await rejected(() => service.create(creatorUser.id, proposal), proof.forbidden);
      await rejected(() => service.create(admin.id, {...proposal, commissionBps: proof.zero}), proof.badRequest);
      await rejected(() => service.change(admin.id, creator.id, {gradeCode: proposal.code, expectedVersion: creator.gradeVersion, reason: proof.reason, actorId: admin.id}), proof.badRequest);
      const created = await service.create(admin.id, proposal); assert.equal(created.version,proof.one); assert.equal(created.updatedAt,created.createdAt); cases++;
      const [stored] = await db.select().from(schema.creatorGrades).where(eq(schema.creatorGrades.code,created.code)); assert.equal(stored.commissionBps,null); cases++;
      await flush();
      await rejected(() => service.create(admin.id,proposal),proof.conflict);
      const revision = {expectedVersion: created.version,label:proof.revised,rank:proof.nextRank,assignable:false,reason:proof.reason};
      const revised = await service.revise(admin.id,created.code,revision); assert.equal(revised.version,proof.two); cases++;
      await rejected(() => service.revise(admin.id,created.code,revision),proof.conflict);
      const filtered = await service.list(admin.id,{assignable:'false',search:created.code}); assert.equal(filtered.items.length,proof.one); assert.equal(filtered.items[proof.first].code,created.code); cases++;
      const literal = await service.list(admin.id,{search:'%'}); assert.equal(literal.items.length,proof.zero); cases++;
      const history = await service.history(admin.id,created.code,{limit:proof.one}); assert.equal(history.items[proof.first].version,proof.two); assert(history.nextCursor); cases++;
      const prior = await service.history(admin.id,created.code,{limit:proof.one,cursor:history.nextCursor}); assert.equal(prior.items[proof.first].version,proof.one); assert.equal(prior.nextCursor,null); cases++;
      const other = await service.create(admin.id,{...proposal,code:proof.prefix + randomUUID()});
      await rejected(() => service.history(admin.id,other.code,{cursor:history.nextCursor}),proof.badRequest);
      await rejected(() => service.change(admin.id,creator.id,{gradeCode:created.code,expectedVersion:creator.gradeVersion,reason:proof.reason}),proof.conflict);
      const target = await service.revise(admin.id,created.code,{...revision,expectedVersion:revised.version,assignable:true});
      const beforeAssignment = await service.assignment(admin.id,creator.id);
      const changed = await service.change(admin.id,creator.id,{gradeCode:target.code,expectedVersion:beforeAssignment.version,reason:proof.reason});
      assert.equal(changed.assignment.version,beforeAssignment.version + proof.one); assert.equal(changed.change.fromGradeCode,beforeAssignment.gradeCode);
      assert.equal(changed.change.fromGradeLabel,beforeAssignment.gradeLabel); assert.equal(changed.change.toGradeLabel,target.label); assert.equal(changed.change.changedByUserId,admin.id); cases++;
      await flush();
      await rejected(() => service.change(admin.id,creator.id,{gradeCode:other.code,expectedVersion:beforeAssignment.version,reason:proof.reason}),proof.conflict);
      await rejected(() => service.change(admin.id,creator.id,{gradeCode:target.code,expectedVersion:changed.assignment.version,reason:proof.reason}),proof.conflict);
      const currentPage = await service.assignmentHistory(admin.id,creator.id,{limit:proof.one}); assert.equal(currentPage.items[proof.first].id,changed.change.id); assert(currentPage.nextCursor); cases++;
      const oldPage = await service.assignmentHistory(admin.id,creator.id,{limit:proof.one,cursor:currentPage.nextCursor}); assert.equal(oldPage.items[proof.first].source,null); assert.equal(oldPage.items[proof.first].version,null); cases++;
      const seed = await service.current(admin.id,beforeAssignment.gradeCode);
      await rejected(() => service.revise(admin.id,seed.code,{...revision,expectedVersion:seed.version,assignable:false}),proof.conflict);
      const assignmentPage = await service.assignments(admin.id,{search:creator.slug,limit:proof.one}); assert.equal(assignmentPage.items[proof.first].creatorId,creator.id); cases++;
      await client.query('savepoint grade_suspended_creator');
      await db.update(schema.users).set({status:proof.suspended}).where(eq(schema.users.id,creatorUser.id));
      await rejected(() => service.change(admin.id,creator.id,{gradeCode:other.code,expectedVersion:changed.assignment.version,reason:proof.reason}),proof.conflict);
      await client.query('rollback to savepoint grade_suspended_creator');
      await client.query('release savepoint grade_suspended_creator');
      await client.query('savepoint grade_suspended_actor');
      await db.update(schema.users).set({status:proof.suspended}).where(eq(schema.users.id,admin.id));
      await rejected(() => service.list(admin.id,{}),proof.forbidden);
      await rejected(() => service.revise(admin.id,target.code,{...revision,expectedVersion:target.version}),proof.forbidden);
      await client.query('rollback to savepoint grade_suspended_actor');
      await client.query('release savepoint grade_suspended_actor');
      const newId=randomUUID(), appId=randomUUID();
      await db.insert(schema.users).values({id:newId,supabaseUserId:randomUUID(),email:newId+'@example.invalid',status:proof.active});
      const [application] = await db.insert(schema.creatorApplications).values({id:appId,userId:newId,displayName:proof.label,email:newId+'@example.invalid',motivation:proof.reason,status:proof.accepted}).returning();
      await new CreatorsService(new DrizzleCreatorsRepository({db})).provisionFromApplication(application);
      const [newCreator] = await db.select().from(schema.creatorProfiles).where(eq(schema.creatorProfiles.applicationId,appId)); assert(newCreator);
      const [initial] = await db.select().from(schema.creatorGradeHistory).where(eq(schema.creatorGradeHistory.creatorProfileId,newCreator.id));
      assert.equal(initial.version,proof.one); assert.equal(initial.source,'application'); assert.equal(initial.fromGradeCode,null); assert.equal(initial.toGradeCode,seed.code); assert.equal(initial.toGradeLabel,seed.label); cases++;
      await flush();
      throw new VerificationRollback();
      });
    } catch (error) {
      if (!(error instanceof VerificationRollback)) {
        console.error('Grade verification scenario count:',cases);
        if (error instanceof Error && error.cause && typeof error.cause === 'object' && 'code' in error.cause) console.error('SQL state:',String(error.cause.code));
        throw error;
      }
    }
    for (const table of tables) assert.equal(await fingerprint(table),before.get(table),'Rollback changed table '+table);
    console.log(JSON.stringify({scenarios:cases,rolledBack:true,unchangedTables:tables.length,providerCalls:proof.zero}));
  } finally {client.release();await pool.end();}
}
verify().catch(()=>{console.error('Creator grade service verification failed; transaction rolled back.');process.exitCode=1;});
