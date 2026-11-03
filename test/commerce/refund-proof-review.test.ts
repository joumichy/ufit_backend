import 'reflect-metadata';
import {createHash} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {REFUND_PROOF_REVIEW as R,refundProofReviewCommandSchema,refundReviewFingerprint} from '../../src/modules/orders/domain/refund-proof-review';
import {REFUND_ORGANIZATION as O} from '../../src/modules/orders/domain/refund-organization';
import {RefundProofReviewService} from '../../src/modules/orders/application/refund-proof-review.service';

const fixture={id:'04ae656f-663e-4bcd-9c51-35c8f43b1c85',request:'cdb74d35-48c1-43d9-b59d-3270c9f78876',actor:'fc87f43f-4c18-476f-93cd-5fdb3f1b47f3',
  version:2,reason:'SPECIMEN — no transfer; document rejected.',verification:'SQL-ROLLBACK-ONLY',amount:500,invalid:'invalid-id',inputStatus:400,missingStatus:404} as const;
const reject={requestId:fixture.request,expectedVersion:fixture.version,proofId:fixture.id,reason:fixture.reason,decision:R.decision.reject};
const confirm={...reject,decision:R.decision.confirm,verificationReference:fixture.verification};
const access={scope:O.scope.administrator,actorId:fixture.actor};
function dependencies(){
  const repository={prepare:vi.fn(),review:vi.fn(),receipt:vi.fn()},storage={uploadOrVerify:vi.fn(),download:vi.fn()};
  return {repository,storage,service:new RefundProofReviewService(repository,storage)};
}
describe('Refund proof review boundary',()=>{
  it.each([{...reject,requestId:fixture.invalid},{...reject,proofId:fixture.invalid},{...reject,expectedVersion:O.revision.absent},
    {...reject,reason:''},{...reject,reason:'x'.repeat(R.text.reasonMaximum+O.revision.step)},
    {...reject,amount:fixture.amount},{...reject,verificationReference:fixture.verification},
    {...confirm,verificationReference:''},{...confirm,verificationReference:null},{...confirm,verificationReference:undefined},
    {...confirm,decision:'approve'},{...confirm,expectedVersion:String(fixture.version)}])('rejects incomplete, forged or mixed financial decisions before storage or SQL',async raw=>{
    const {repository,storage,service}=dependencies();
    await expect(service.review(access,'return',fixture.id,raw)).rejects.toMatchObject({status:fixture.inputStatus});
    expect(repository.prepare).not.toHaveBeenCalled();expect(storage.download).not.toHaveBeenCalled();
  });
  it('normalizes meaningful text once and fingerprints the exact canonical decision',()=>{
    const clean=refundProofReviewCommandSchema.parse(reject),normalized=refundProofReviewCommandSchema.parse({...reject,reason:' '+fixture.reason+' '});
    expect(clean).toEqual(normalized);expect(refundReviewFingerprint(clean)).toBe(refundReviewFingerprint(normalized));
    expect(refundReviewFingerprint(refundProofReviewCommandSchema.parse(confirm))).not.toBe(refundReviewFingerprint(clean));
  });
  it('recovers an exact recorded command without requiring Storage again or repeating financial effects',async()=>{
    const {repository,storage,service}=dependencies(),result={receipt:{requestId:fixture.request,proofId:fixture.id,decision:R.decision.confirm}};
    repository.prepare.mockResolvedValue({kind:R.stage.recorded,result});
    expect(await service.review(access,'return',fixture.id,confirm)).toBe(result);expect(storage.download).not.toHaveBeenCalled();expect(repository.review).not.toHaveBeenCalled();
  });
  it('permits rejection of an unreadable file without claiming its financial verification',async()=>{
    const {repository,storage,service}=dependencies();repository.prepare.mockResolvedValue({kind:R.stage.reviewable,asset:{id:fixture.id}});
    await service.review(access,'return',fixture.id,reject);
    expect(storage.download).not.toHaveBeenCalled();expect(repository.review).toHaveBeenCalledExactlyOnceWith(access,{kind:'return',id:fixture.id},refundProofReviewCommandSchema.parse(reject),null);
  });
  it('does not record confirmation if immutable storage cannot verify the document',async()=>{
    const {repository,storage,service}=dependencies();repository.prepare.mockResolvedValue({kind:R.stage.reviewable,asset:{id:fixture.id}});storage.download.mockRejectedValue(new Error('unavailable'));
    await expect(service.review(access,'return',fixture.id,confirm)).rejects.toThrow('unavailable');expect(repository.review).not.toHaveBeenCalled();
  });
  it('passes the downloaded file identity to the locked settlement boundary before confirming',async()=>{
    const {repository,storage,service}=dependencies(),bytes=Buffer.from(fixture.reason),asset={id:fixture.id},result={receipt:{requestId:fixture.request,proofId:fixture.id,decision:R.decision.confirm}};
    repository.prepare.mockResolvedValue({kind:R.stage.reviewable,asset});storage.download.mockResolvedValue(bytes);repository.review.mockResolvedValue(result);
    expect(await service.review(access,'return',fixture.id,confirm)).toBe(result);
    expect(storage.download).toHaveBeenCalledExactlyOnceWith(asset);
    expect(repository.review).toHaveBeenCalledExactlyOnceWith(access,{kind:'return',id:fixture.id},refundProofReviewCommandSchema.parse(confirm),{sha256:createHash(O.hash.algorithm).update(bytes).digest(O.hash.encoding),byteSize:bytes.length});
  });
  it('returns a missing receipt without turning the absence into a successful refund',async()=>{
    const {repository,service}=dependencies();repository.receipt.mockResolvedValue(undefined);
    await expect(service.receipt(access,'return',fixture.id,fixture.request)).rejects.toMatchObject({status:fixture.missingStatus});
  });
});
