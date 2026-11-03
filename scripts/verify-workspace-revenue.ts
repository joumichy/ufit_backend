import 'reflect-metadata';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {sql} from 'drizzle-orm';
import {DatabaseService} from '../src/shared/infrastructure/database/database.service';
import {getEnv} from '../src/config/env';
import {READ_SNAPSHOT} from '../src/shared/infrastructure/database/database-session';
import {DrizzleWorkspacesRepository} from '../src/modules/workspaces/infrastructure/drizzle-workspaces.repository';
import {WorkspacesService} from '../src/modules/workspaces/application/workspaces.service';
import {WORKSPACE_REVENUE, workspaceRevenueSchema} from '../src/modules/workspaces/domain/workspace-revenue';

const qualification = {
  node: 'development', port: 4014, schema: 'ufit', registryPath: '/.codex/private/ufit/qualification.credentials.json',
  forbidden: 403, notFound: 404, invalid: 400, invalidPeriod: 'invalid', first: 0, limit: 1,
} as const;

async function verify() {
  const env = getEnv();
  assert(env.NODE_ENV === qualification.node && env.API_PORT === qualification.port && env.UFIT_DB_SCHEMA === qualification.schema, 'Requires selected development4014 profile');
  const registry = JSON.parse(await readFile(homedir() + qualification.registryPath, 'utf8'));
  const database = new DatabaseService();
  let checks = 0;
  try {
    const repository = new DrizzleWorkspacesRepository(database), service = new WorkspacesService(repository);
    const creatorID = registry.creator.userId, brandUserID = registry.brand.userId;
    const brand = (await repository.listBrandsForUser(brandUserID, qualification.limit)).items[qualification.first]; assert(brand);
    await database.db.transaction(async tx => {
      const settings = await tx.execute(sql`select current_setting('transaction_read_only') as mode, current_setting('transaction_isolation') as isolation`);
      assert.equal(settings.rows[0].mode, 'on'); assert.equal(settings.rows[0].isolation, 'repeatable read'); checks++;
    }, READ_SNAPSHOT);
    for (const period of WORKSPACE_REVENUE.periods) {
      const creator = await service.getCreatorRevenue(creatorID, {period});
      const brandRevenue = await service.getBrandRevenue(brand.id, brandUserID, {period});
      for (const document of [creator, brandRevenue]) {
        workspaceRevenueSchema.parse(document); checks++;
        // Independent captured-order aggregate: no revenue-reader SQL or client fixtures.
        const source = await database.query<{currency:string;liveMode:boolean|null;captured:string}>(`
          select o.currency,s.live_mode as "liveMode",sum(${document.kind === 'creator' ? `(select coalesce(sum(oi.total_price),0) from ufit.order_items oi where oi.order_id=o.id and oi.source_creator_id=$1)` : 'o.total_amount'})::text as captured
          from ufit.orders o join ufit.payments p on p.order_id=o.id and p.provider='stripe' and p.provider_payment_intent_id=o.stripe_payment_intent_id and p.status in ('succeeded','refunded')
          left join ufit.payment_settlements s on s.payment_id=p.id
          where o.payment_provider='stripe' and o.created_at >= $2::date at time zone 'UTC' and o.created_at <= $3::timestamptz
            and ${document.kind === 'creator' ? 'exists(select 1 from ufit.order_items oi where oi.order_id=o.id and oi.source_creator_id=$1)' : 'o.brand_id=$1'}
          group by o.currency,s.live_mode`,[document.profileId,document.start,document.asOf]);
        for (const row of source.rows) assert.equal(document.currencies.find(value=>value.currency===row.currency&&value.liveMode===row.liveMode)?.points.reduce((sum,value)=>sum+BigInt(value.captured),0n),BigInt(row.captured));
        checks++;
      }
    }
    await assert.rejects(service.getBrandRevenue(brand.id,creatorID,{}), (error: any)=>error.getStatus?.()===qualification.forbidden); checks++;
    await assert.rejects(service.getCreatorRevenue(registry.customer.userId,{}), (error: any)=>error.getStatus?.()===qualification.notFound); checks++;
    await assert.rejects(service.getCreatorRevenue(creatorID,{period:qualification.invalidPeriod}), (error: any)=>error.getStatus?.()===qualification.invalid); checks++;
    console.log(JSON.stringify({checks,periods:WORKSPACE_REVENUE.periods,readOnly:true,captureTotalsMatched:true,scopeChecks:true}));
  } finally { await database.onModuleDestroy(); }
}
verify().catch(error => { console.error(error.name, error.code ?? 'verification_failed'); process.exitCode=1; });
