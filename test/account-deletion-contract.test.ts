import 'reflect-metadata';
import {describe,expect,it} from 'vitest';
import {ACCOUNT_DELETION as D,deletionInputSchema,deletionProofSchema,deletionReceiptSchema} from '../src/modules/identity/domain/account-deletion.contract';
import {deletionCredentialHash} from '../src/modules/identity/infrastructure/persistence/drizzle-account-deletion-queue';

const F={requestId:'9ce0a988-62bd-45fd-98a0-7627413ae8f4',date:'2026-11-02T00:00:00.000Z',later:'2026-11-02T00:01:00.000Z',
  earlier:'2026-11-01T23:59:00.000Z',proof:'ab'.repeat(32),wrong:'cd'.repeat(32),legacy:'deleted',invalidDate:'today',
  privateEmail:'qualification@example.invalid'} as const;
const pending={requestId:F.requestId,phase:D.phase.purging,requestedAt:F.date,completedAt:null};
describe('Account deletion private receipt contract',()=>{
  it('accepts one explicit confirmation and no body-controlled actor',()=>{
    expect(deletionInputSchema.parse({confirmed:true})).toEqual({confirmed:true});
    for(const input of [{},{confirmed:false},{confirmed:true,userId:F.requestId},{confirmed:true,proof:F.proof}]) {
      expect(deletionInputSchema.safeParse(input).success).toBe(false);
    }
  });
  it('exposes only canonical progression and timestamps',()=>{
    expect(deletionReceiptSchema.parse(pending)).toEqual(pending);
    expect(deletionReceiptSchema.parse({...pending,phase:D.phase.revoking})).toEqual({...pending,phase:D.phase.revoking});
    expect(deletionReceiptSchema.parse({...pending,phase:D.phase.completed,completedAt:F.later}).completedAt).toBe(F.later);
  });
  it.each([
    {...pending,completedAt:undefined},{...pending,completedAt:F.later},{...pending,phase:D.phase.completed},
    {...pending,phase:D.phase.completed,completedAt:F.earlier},{...pending,phase:F.legacy},
    {...pending,requestedAt:F.invalidDate},{...pending,proofHash:F.proof},{...pending,email:F.privateEmail},
    {...pending,userId:F.requestId},{...pending,authUserId:F.requestId},
  ])('rejects missing, contradictory or private fields',value=>expect(deletionReceiptSchema.safeParse(value).success).toBe(false));
  it('requires a separate fixed-size capability and stores only its digest',()=>{
    expect(deletionProofSchema.parse(F.proof)).toBe(F.proof);
    for(const input of [F.proof.toUpperCase(),[F.proof],F.proof.trimEnd().slice(1)])expect(deletionProofSchema.safeParse(input).success).toBe(false);
    expect(deletionCredentialHash(F.proof)).not.toBe(F.proof);
    expect(deletionCredentialHash(F.proof)).not.toBe(deletionCredentialHash(F.wrong));
    expect(deletionCredentialHash(F.proof)).toBe(deletionCredentialHash(F.proof));
    expect(()=>deletionCredentialHash([F.proof])).toThrow();
  });
});
