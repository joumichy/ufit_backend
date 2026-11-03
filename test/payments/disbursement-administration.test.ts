import {describe,expect,it} from 'vitest';
import {DisbursementAdministrationService} from '../../src/modules/payments/application/disbursement-administration.service';
import {disbursementDocumentSchema,type DisbursementAdministrationRepository,type DisbursementAdministrationSession} from '../../src/modules/payments/domain/payment-disbursement-administration';
import type {IdentityAccess} from '../../src/modules/identity/domain/user.types';
import {F} from './payment-transfer.fixtures';

function fixture(){
  let identity:IdentityAccess|undefined={status:'active',roles:['admin']},exists=true;
  const events:string[]=[];
  const document={paymentId:F.id.payment,orderId:F.id.order,asOf:F.date.created,state:'not_requested' as const,reason:null,nextAttemptAt:null,assessment:null,assessmentRecordedAt:null,operations:[]};
  const session:DisbursementAdministrationSession={async lockOrder(){events.push('order');},async access(actor,write){expect(actor).toBe(F.id.other);events.push(write?'identity-lock':'identity-read');return identity;},
    async document(id){expect(id).toBe(F.id.payment);return exists?document:undefined;},async resume(){events.push('resume');}};
  const repo:DisbursementAdministrationRepository={async administration(write,operation){events.push(write?'write':'read');return operation(session);}};
  return{service:new DisbursementAdministrationService(repo,{canExecute:true}),document,events,access:(value:IdentityAccess|undefined)=>identity=value,missing:()=>exists=false};
}
describe('disbursement administration access and canonical document',()=>{
  it('reads an authenticated administrator snapshot without requesting a transfer',async()=>{
    const f=fixture();expect(await f.service.document(F.id.other,F.id.payment)).toEqual(f.document);expect(f.events).toEqual(['read','identity-read']);
  });
  it('locks the order before identity and job changes when resuming',async()=>{
    const f=fixture();await f.service.resume(F.id.other,F.id.payment,{});expect(f.events).toEqual(['write','order','identity-lock','resume']);
  });
  it('refuses non-admin and suspended identities before exposing finance or mutating the queue',async()=>{
    const f=fixture();for(const identity of [{status:'active',roles:['creator']},{status:'suspended',roles:['admin']}] as IdentityAccess[]){
      f.access(identity);await expect(f.service.document(F.id.other,F.id.payment)).rejects.toMatchObject({status:403});
      await expect(f.service.resume(F.id.other,F.id.payment,{})).rejects.toMatchObject({status:403});
    }expect(f.events).not.toContain('resume');
  });
  it('rejects client amounts, malformed identities and a missing capture',async()=>{
    const f=fixture();expect(()=>f.service.resume(F.id.other,F.id.payment,{amount:1})).toThrow();
    expect(()=>f.service.document(F.id.other,'invalid-payment')).toThrow();f.missing();await expect(f.service.document(F.id.other,F.id.payment)).rejects.toMatchObject({status:404});
  });
  it('requires an actual receipt for recorded state and an explicit funding kind for transfers',()=>{
    const f=fixture(),operation={id:F.id.operation,kind:'transfer',armed:true,state:'recorded',allocationKey:'brand/'+F.id.brand,originalOperationId:null,
      amount:F.money.brandSettled,currency:F.currency.settlement,funding:'charge',createdAt:F.date.created,receipt:null};
    expect(disbursementDocumentSchema.safeParse({...f.document,operations:[operation]}).success).toBe(false);
    const received={...operation,receipt:{id:F.provider.transfer,recordedAt:F.date.created}};
    expect(disbursementDocumentSchema.safeParse({...f.document,operations:[received]}).success).toBe(true);
    expect(disbursementDocumentSchema.safeParse({...f.document,operations:[{...received,funding:null}]}).success).toBe(false);
  });
});
