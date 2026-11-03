import 'reflect-metadata';
import {describe, expect, it, vi} from 'vitest';
import {REFUND_ORGANIZATION as O, applyOrganization, organizationActions, organizationFingerprint, refundOrganizationCommandSchema,
  type RefundOrganization, type RefundOrganizationCommand} from '../../src/modules/orders/domain/refund-organization';
import {REFUND_RECOVERY as R} from '../../src/modules/orders/domain/refund-recovery.contract';
import {RefundOrganizationService} from '../../src/modules/orders/application/refund-organization.service';

const fixture = {
  requestId:'0bc9ccce-4b34-4b89-91c6-b052b0c0dbcd',id:'5b74004b-cfec-4ffe-8fc4-753d64500714',actorId:'77e71bf0-ddd0-40d9-9293-adf72ab8b6dd',
  methodLabel:'Virement convenu',instructions:'Indiquez vos coordonnées de remboursement.',details:'SPECIMEN — aucune coordonnée bancaire réelle.',
  now:'2026-11-03T02:00:00.000Z',changedNow:'2026-11-03T02:01:00.000Z',otherMethod:'Autre moyen convenu',
  invalidVersion:-1,tooLargeVersion:2147483647,invalidField:'amount',forgedAmount:1,invalidKind:'order',invalidId:'foreign-id',
  status:{input:400,denied:403,conflict:409,missing:404},
} as const;
const arrange:RefundOrganizationCommand={requestId:fixture.requestId,expectedVersion:O.revision.absent,action:O.action.arrange,methodLabel:fixture.methodLabel,instructions:fixture.instructions};
const organized:RefundOrganization={version:O.revision.first,status:O.status.awaitingCustomer,methodLabel:fixture.methodLabel,instructions:fixture.instructions,customerDetails:null,updatedAt:fixture.now};
const reply:RefundOrganizationCommand={requestId:fixture.requestId,expectedVersion:O.revision.first,action:O.action.provideDetails,details:fixture.details};
const staff={scope:O.scope.administrator,actorId:fixture.actorId};
describe('Refund organization policy and API contract',()=>{
  it('distinguishes an absent arrangement, waiting for the customer and a ready response without any payment-success state',()=>{
    expect(organizationActions(O.scope.administrator,null)).toEqual([O.action.arrange]);
    expect(organizationActions(O.scope.customer,null)).toEqual([]);
    expect(organizationActions(O.scope.brand,organized)).toEqual([]);
    expect(applyOrganization(null,O.scope.administrator,arrange,fixture.now)).toEqual(organized);
    const ready=applyOrganization(organized,O.scope.customer,reply,fixture.changedNow);
    expect(ready).toEqual({...organized,version:O.revision.first+O.revision.step,status:O.status.ready,customerDetails:fixture.details,updatedAt:fixture.changedNow});
    expect(Object.values(O.status)).toEqual(['awaiting_customer','ready']);
  });
  it('requests fresh customer details when instructions change, preserving the previous value in the immutable input',()=>{
    const ready=applyOrganization(organized,O.scope.customer,reply,fixture.changedNow),before=structuredClone(ready);
    const next=applyOrganization(ready,O.scope.administrator,{...arrange,expectedVersion:ready.version,methodLabel:fixture.otherMethod},fixture.changedNow);
    expect(next.customerDetails).toBeNull();expect(next.status).toBe(O.status.awaitingCustomer);expect(next.methodLabel).toBe(fixture.otherMethod);
    expect(ready).toEqual(before);expect(ready.customerDetails).toBe(fixture.details);
  });
  it('does not let a customer or brand publish instructions, or an administrator impersonate a customer response',()=>{
    for(const scope of [O.scope.customer,O.scope.brand]) expect(()=>applyOrganization(organized,scope,arrange,fixture.now)).toThrow(expect.objectContaining({status:fixture.status.denied}));
    expect(()=>applyOrganization(organized,O.scope.administrator,reply,fixture.now)).toThrow(expect.objectContaining({status:fixture.status.denied}));
  });
  it('requires the exact revision and closes new commands at the revision ceiling',()=>{
    expect(()=>applyOrganization(organized,O.scope.administrator,arrange,fixture.now)).toThrow(expect.objectContaining({status:fixture.status.conflict}));
    expect(organizationActions(O.scope.customer,{...organized,version:O.revision.maximum})).toEqual([]);
    expect(organizationActions(O.scope.administrator,{...organized,version:O.revision.maximum})).toEqual([]);
  });
  it.each([
    {...arrange,expectedVersion:fixture.invalidVersion},{...arrange,expectedVersion:fixture.tooLargeVersion},
    {...arrange,methodLabel:''},{...arrange,instructions:'   '},{...arrange,methodLabel:'x'.repeat(O.text.method+O.revision.step)},
    {...arrange,instructions:'x'.repeat(O.text.instructions+O.revision.step)}, {...reply,details:''},
    {...reply,details:'x'.repeat(O.text.details+O.revision.step)}, {...arrange,[fixture.invalidField]:fixture.forgedAmount},
    {...reply,instructions:fixture.instructions}, {...arrange,requestId:fixture.invalidId},
  ])('rejects malformed or mixed command data %j before persistence',raw=>{
    const repository={read:vi.fn(),apply:vi.fn(),receipt:vi.fn()},service=new RefundOrganizationService(repository);
    expect(()=>service.apply(staff,R.kind.orderReturn,fixture.id,raw)).toThrow(expect.objectContaining({status:fixture.status.input}));
    expect(repository.apply).not.toHaveBeenCalled();
  });
  it('normalizes field whitespace once before fingerprinting and persistence',async()=>{
    const repository={read:vi.fn(),apply:vi.fn(),receipt:vi.fn()},service=new RefundOrganizationService(repository);
    await service.apply(staff,R.kind.orderReturn,fixture.id,{...arrange,methodLabel:' '+fixture.methodLabel+' '});
    expect(repository.apply).toHaveBeenCalledExactlyOnceWith(staff,{kind:R.kind.orderReturn,id:fixture.id},arrange);
    const normalized=refundOrganizationCommandSchema.parse({...arrange,methodLabel:' '+fixture.methodLabel+' '});
    expect(organizationFingerprint(normalized)).toBe(organizationFingerprint(arrange));
    expect(organizationFingerprint({...arrange,methodLabel:fixture.otherMethod})).not.toBe(organizationFingerprint(arrange));
  });
  it('validates the origin and command receipt identifiers without guessing an order UUID',async()=>{
    const repository={read:vi.fn(),apply:vi.fn(),receipt:vi.fn(async()=>undefined)},service=new RefundOrganizationService(repository);
    expect(()=>service.read(staff,fixture.invalidKind,fixture.id)).toThrow();expect(repository.read).not.toHaveBeenCalled();
    await expect(service.receipt(staff,R.kind.orderReturn,fixture.id,fixture.invalidId)).rejects.toMatchObject({status:fixture.status.input});
    expect(repository.receipt).not.toHaveBeenCalled();
    await expect(service.receipt(staff,R.kind.orderReturn,fixture.id,fixture.requestId)).rejects.toMatchObject({status:fixture.status.missing});
    expect(repository.receipt).toHaveBeenCalledExactlyOnceWith(staff,{kind:R.kind.orderReturn,id:fixture.id},fixture.requestId);
  });
});
