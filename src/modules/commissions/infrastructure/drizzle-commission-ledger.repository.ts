import {BadRequestException,ConflictException,Inject,Injectable} from '@nestjs/common';
import {eq,sql,type SQL} from 'drizzle-orm';
import {z} from 'zod';
import {DatabaseService} from '../../../shared/infrastructure/database/database.service';
import {READ_SNAPSHOT,type DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {creatorProfiles,commissionRules,orderItems,orderReturns,orderReturnItems,returnCommissionAdjustments} from '../../../shared/infrastructure/database/schema';
import {findIdentityAccess,IdentityAccessMode} from '../../identity/infrastructure/persistence/identity-access';
import {WORKSPACE_FINANCE,requireWorkspaceProjection,workspaceInteger} from '../../workspaces/domain/workspace-finance';
import {COMMISSION_RELEASE,type CommissionFinancialScope} from '../domain/commission-release';
import {COMMISSION_ENTRY,commissionEntrySchema} from '../domain/commission-entry.contract';
import {COMMISSION_LEDGER as LEDGER,commissionLedgerPageSchema,commissionLedgerDetailSchema,commissionRelatedReturnSchema,
  type CommissionLedgerQuery,type CommissionCursorQuery,type CommissionLedgerPage,type CommissionLedgerDetail,type CommissionRelatedReturn} from '../domain/commission-ledger.contract';
import type {CommissionLedgerRepository} from '../domain/commission-ledger.repository';
import {parseStoredRate,calculateRateBps} from '../domain/commission-rule.contract';
import {commissionFinancialFacts} from './commission-financial-facts.sql';
import {commissionEntryColumns,projectCommissionEntry} from './commission-entry.projection';

const limits=LEDGER.limits;
const timestamp=COMMISSION_ENTRY.timestamp;
const asOf=sql`to_char(current_timestamp at time zone ${timestamp.zone},${timestamp.format})`;
@Injectable()
export class DrizzleCommissionLedgerRepository implements CommissionLedgerRepository{
  constructor(@Inject(DatabaseService)private readonly database:DatabaseSession){}
  snapshot<T>(operation:(repository:CommissionLedgerRepository)=>Promise<T>):Promise<T>{return this.database.db.transaction(tx=>operation(new DrizzleCommissionLedgerRepository({db:tx})),READ_SNAPSHOT);}
  access(actorId:string){return findIdentityAccess(this.database,actorId,IdentityAccessMode.Read);}
  async creatorIdForUser(actorId:string){const[row]=await this.database.db.select({id:creatorProfiles.id}).from(creatorProfiles).where(eq(creatorProfiles.userId,actorId)).limit(limits.one);return row?.id;}
  page(scope:CommissionFinancialScope,query:CommissionLedgerQuery){
    const conditions:SQL[]=[];
    if(query.state)conditions.push(sql`release_state=${query.state}`);
    if(query.currency)conditions.push(sql`currency=${query.currency}`);
    if(query.search){const pattern=LEDGER.search.wildcard+query.search.replace(/[\\%_]/g,value=>LEDGER.search.escape+value)+LEDGER.search.wildcard;
      conditions.push(sql`(order_number ilike ${pattern} escape ${LEDGER.search.escape} or product_name ilike ${pattern} escape ${LEDGER.search.escape}
        or brand_name ilike ${pattern} escape ${LEDGER.search.escape} or creator_name ilike ${pattern} escape ${LEDGER.search.escape})`);}
    const condition=conditions.length?sql.join(conditions,sql` and `):sql`true`;
    const collection=sql`${commissionFinancialFacts(scope)},ledger_all as(select f.*,created_at as sort_at from facts f),
      ledger_records as(select * from ledger_all where ${condition})`;
    return this.readPage(collection,query,commissionEntryColumns,projectCommissionEntry,commissionEntrySchema);
  }
  async detail(id:string):Promise<CommissionLedgerDetail|undefined>{
    const result=await this.database.db.execute(sql`${commissionFinancialFacts({kind:COMMISSION_RELEASE.scope.administration})}
      select ${commissionEntryColumns},order_id as "orderId",invalid,${asOf} as "asOf" from facts where id=${id}`);
    const row=result.rows[limits.zero];if(!row)return undefined;if(row.invalid!==false)throw new ConflictException(WORKSPACE_FINANCE.failure.persisted);
    const commission=projectCommissionEntry(row);
    const [reference]=await this.database.db.select({ruleId:orderItems.commissionRuleId,grade:orderItems.commissionCreatorGradeCode}).from(orderItems).where(eq(orderItems.id,commission.orderItemId));
    if(!reference)throw new ConflictException(WORKSPACE_FINANCE.failure.persisted);
    let rule:CommissionLedgerDetail['rule']=null;
    if(reference.ruleId!==null){const[record]=await this.database.db.select().from(commissionRules).where(eq(commissionRules.id,reference.ruleId));
      if(!record||reference.grade===null)throw new ConflictException(WORKSPACE_FINANCE.failure.persisted);
      const rates={baseRateBps:parseStoredRate(record.baseRate),bonusRateBps:parseStoredRate(record.bonusRate),maxRateBps:record.maxRate===null?null:parseStoredRate(record.maxRate)};
      if(calculateRateBps(rates)!==commission.rateBps)throw new ConflictException(WORKSPACE_FINANCE.failure.persisted);
      rule={id:record.id,scopeId:record.scopeId,revision:record.revision,creatorGradeCode:reference.grade,...rates};
    }
    const count=await this.database.db.execute(sql`select count(*)::text as value from ${orderReturnItems} where order_item_id=${commission.orderItemId}`);
    return requireWorkspaceProjection(commissionLedgerDetailSchema,{commission,orderId:row.orderId,relatedReturnCount:workspaceInteger(count.rows[limits.zero].value),rule,asOf:row.asOf});
  }
  relatedReturns(id:string,query:CommissionCursorQuery):Promise<CommissionLedgerPage<CommissionRelatedReturn>>{
    const collection=sql`${commissionFinancialFacts({kind:COMMISSION_RELEASE.scope.administration})},ledger_all as(
      select r.id,r.status,r.version,r.created_at as sort_at,r.created_at as requested_at,ri.quantity,f.currency,
        coalesce(a.amount,${limits.zero}) as adjusted_amount,f.invalid or ri.quantity<${limits.one} or coalesce(a.amount,${limits.zero})<${limits.zero} as invalid
      from facts f join ${orderReturnItems} ri on ri.order_item_id=f.order_item_id join ${orderReturns} r on r.id=ri.return_id
      left join ${returnCommissionAdjustments} a on a.return_item_id=ri.id and a.commission_id=f.id where f.id=${id}
    ),ledger_records as(select * from ledger_all)`;
    const columns=sql`id,status,version::text as version,quantity::text as quantity,adjusted_amount::text as "adjustedAmount",currency,
      to_char(requested_at at time zone ${timestamp.zone},${timestamp.format}) as "requestedAt"`;
    return this.readPage(collection,query,columns,row=>requireWorkspaceProjection(commissionRelatedReturnSchema,{id:row.id,status:row.status,version:workspaceInteger(row.version),
      quantity:workspaceInteger(row.quantity),adjustedAmount:workspaceInteger(row.adjustedAmount),currency:row.currency,requestedAt:row.requestedAt}),commissionRelatedReturnSchema);
  }
  private async readPage<T extends {id:string}>(collection:SQL,query:CommissionCursorQuery,columns:SQL,project:(row:Record<string,unknown>)=>T,schema:z.ZodType<T>):Promise<CommissionLedgerPage<T>>{
    const metadata=await this.database.db.execute(sql`${collection} select count(*)::text as total,
      md5(coalesce(jsonb_agg(to_jsonb(r) order by sort_at desc,id desc),${LEDGER.revision.emptyJson}::jsonb)::text) as revision,${asOf} as "asOf",
      (select count(*) filter(where invalid)::text from ledger_all) as invalid,array(select distinct currency from ledger_all order by currency) as currencies from ledger_records r`);
    const meta=metadata.rows[limits.zero];if(workspaceInteger(meta.invalid)!==limits.zero)throw new ConflictException(WORKSPACE_FINANCE.failure.persisted);
    if(query.revision!==undefined&&query.revision!==meta.revision)throw new ConflictException(LEDGER.failure.changed);
    let after=sql`true`;
    if(query.cursor){const anchors=await this.database.db.execute(sql`${collection} select id from ledger_records where id=${query.cursor}`);
      const anchor=anchors.rows[limits.zero];if(!anchor)throw new BadRequestException(LEDGER.failure.cursor);
      // Keep PostgreSQL timestamp precision when several records share a creation time.
      after=sql`(sort_at,id)<(select anchor.sort_at,anchor.id from ledger_records anchor where anchor.id=${query.cursor})`;
    }
    const result=await this.database.db.execute(sql`${collection} select ${columns} from ledger_records where ${after} order by sort_at desc,id desc limit ${query.limit+limits.one}`);
    const selected=result.rows.slice(limits.zero,query.limit).map(project);
    return requireWorkspaceProjection(commissionLedgerPageSchema(schema),{items:selected,limit:query.limit,totalCount:workspaceInteger(meta.total),
      nextCursor:result.rows.length>query.limit?selected.at(-limits.one)!.id:null,revision:meta.revision,asOf:meta.asOf,currencies:meta.currencies});
  }
}
