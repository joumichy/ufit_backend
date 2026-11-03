import {describe,it,expect,vi} from 'vitest';
import {BadRequestException,ForbiddenException,NotFoundException} from '@nestjs/common';
import {CommissionLedgerService} from '../../src/modules/commissions/application/commission-ledger.service';
import {COMMISSION_LEDGER,commissionLedgerQuerySchema,commissionRelatedQuerySchema,commissionLedgerPageSchema} from '../../src/modules/commissions/domain/commission-ledger.contract';
import {commissionEntrySchema} from '../../src/modules/commissions/domain/commission-entry.contract';
import type {CommissionLedgerRepository} from '../../src/modules/commissions/domain/commission-ledger.repository';

const actor='11111111-1111-4111-8111-111111111111';
const creator='22222222-2222-4222-8222-222222222222';
const id='33333333-3333-4333-8333-333333333333';
function fixture(roles=['admin'],status='active') {
  let inSnapshot=false;
  const page=vi.fn(async()=>{expect(inSnapshot).toBe(true);return {items:[],limit:20,totalCount:0,nextCursor:null,revision:'a'.repeat(32),asOf:'2026-11-03T00:00:00.000Z',currencies:[]};});
  const access=vi.fn(async()=>{expect(inSnapshot).toBe(true);return {status,roles};});
  const creatorIdForUser=vi.fn(async()=>creator);
  const detail=vi.fn(async()=>undefined);
  const relatedReturns=vi.fn(async()=>page());
  const repository={page,access,creatorIdForUser,detail,relatedReturns,snapshot:async(operation:(value:CommissionLedgerRepository)=>unknown)=>{
    expect(inSnapshot).toBe(false);inSnapshot=true;try{return await operation(repository as CommissionLedgerRepository);}finally{inSnapshot=false;}
  }};
  return {service:new CommissionLedgerService(repository as CommissionLedgerRepository),...repository};
}
describe('commission ledger actor authority',()=>{
  it.each(['admin','super_admin'])('rereads active %s access in the same snapshot',async role=>{
    const f=fixture([role]);await f.service.list(actor,{});
    expect(f.access).toHaveBeenCalledWith(actor);expect(f.page).toHaveBeenCalledWith({kind:'administration'},commissionLedgerQuerySchema.parse({}));
  });
  it.each([['creator','active'],['customer','active'],['admin','suspended'],['super_admin','deleted']])('denies %s/%s before financial reads',async(role,status)=>{
    const f=fixture([role],status);await expect(f.service.list(actor,{})).rejects.toBeInstanceOf(ForbiddenException);expect(f.page).not.toHaveBeenCalled();
  });
  it('resolves creator profile from the authenticated user, without accepting a profile query',async()=>{
    const f=fixture(['creator']);await f.service.listCreator(actor,{state:'paid',limit:20});
    expect(f.creatorIdForUser).toHaveBeenCalledWith(actor);expect(f.page).toHaveBeenCalledWith({kind:'creator',creatorId:creator},commissionLedgerQuerySchema.parse({state:'paid',limit:20}));
    expect(()=>f.service.listCreator(actor,{creatorId:id})).toThrow(BadRequestException);
  });
  it('requires creator role and a persisted profile',async()=>{
    const noRole=fixture(['admin']);await expect(noRole.service.listCreator(actor,{})).rejects.toBeInstanceOf(ForbiddenException);expect(noRole.page).not.toHaveBeenCalled();
    const missing=fixture(['creator']);missing.creatorIdForUser.mockResolvedValueOnce(undefined as never);
    await expect(missing.service.listCreator(actor,{})).rejects.toBeInstanceOf(ForbiddenException);expect(missing.page).not.toHaveBeenCalled();
  });
  it('returns a missing commission before listing its related returns',async()=>{
    const f=fixture();await expect(f.service.detail(actor,id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.service.relatedReturns(actor,id,{})).rejects.toBeInstanceOf(NotFoundException);expect(f.relatedReturns).not.toHaveBeenCalled();
    expect(()=>f.service.detail(actor,'bad-id')).toThrow(BadRequestException);
  });
});
describe('commission ledger wire contract',()=>{
  it.each([{cursor:id},{revision:'a'.repeat(32)},{cursor:id,revision:'bad'},{offset:20},{limit:0},{limit:51},{currency:'FAKE'},{state:'validated'},{search:'x'.repeat(201)}])('rejects incomplete cursors and unsupported filters %j',query=>{
    expect(commissionLedgerQuerySchema.safeParse(query).success).toBe(false);
  });
  it('accepts the exact cursor pair and normalizes literal search text',()=>{
    const value={cursor:id,revision:'a'.repeat(32),state:'payable',currency:'CHF',search:'  100%_  '};
    expect(commissionLedgerQuerySchema.parse(value)).toEqual({...value,search:'100%_',limit:20});
    expect(commissionRelatedQuerySchema.safeParse({...value,search:''}).success).toBe(false);
  });
  it('requires explicit canonical creator and sale identity, with positive quantity',()=>{
    const row={id,orderItemId:id,brandId:id,sourceOutfitId:id,creator:{id:creator,name:'Créateur'},sale:{orderNumber:'QUAL-01',productName:'Chemise',brandName:'Marque',quantity:1},
      currency:'CHF',baseAmount:500,rateBps:500,originalAmount:25,adjustedAmount:0,netAmount:25,paidAdjustmentAmount:0,status:'pending',release:{state:'awaiting_delivery',availableAt:null},createdAt:'2026-11-03T00:00:00.000Z'};
    expect(commissionEntrySchema.safeParse(row).success).toBe(true);
    for(const changed of [{...row,creator:undefined},{...row,sale:undefined},{...row,sale:{...row.sale,quantity:0}},{...row,sale:{...row.sale,productName:' '}},{...row,creator:{...row.creator,name:''}}]){
      expect(commissionEntrySchema.safeParse(changed).success).toBe(false);
    }
    const page={items:[row],limit:20,totalCount:1,nextCursor:null,revision:'a'.repeat(32),asOf:row.createdAt,currencies:['CHF']};
    const schema=commissionLedgerPageSchema(commissionEntrySchema);
    expect(schema.safeParse(page).success).toBe(true);expect(schema.safeParse({...page,items:[row,row]}).success).toBe(false);
    expect(schema.safeParse({...page,nextCursor:creator}).success).toBe(false);
    expect(COMMISSION_LEDGER.cache.value).toBe('private, no-store');
  });
});
