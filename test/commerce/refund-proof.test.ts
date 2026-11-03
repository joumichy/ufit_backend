import 'reflect-metadata';
import {createHash} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {REFUND_PROOF as P,prepareRefundProof,presentRefundProof,refundProofCommandSchema,refundProofFingerprint,type RefundProofAsset} from '../../src/modules/orders/domain/refund-proof.contract';
import {REFUND_ORGANIZATION as O,organizationActions} from '../../src/modules/orders/domain/refund-organization';
import {RefundProofService} from '../../src/modules/orders/application/refund-proof.service';
import {SupabaseRefundProofStorage} from '../../src/modules/orders/infrastructure/supabase-refund-proof.storage';
import type {SupabaseClient} from '@supabase/supabase-js';

const fixture={requestId:'f3d48969-0d3c-477f-adb5-7ec7a4e96475',id:'ed0813c7-9f6d-4d2f-be76-6f2221e638d1',version:4,
  reference:'SPECIMEN — no transfer',date:'2026-11-01',future:'2999-01-01',now:new Date('2026-11-03T01:00:00.000Z'),
  pdf:Buffer.from('%PDF-1.4\nSPECIMEN\n%%EOF'),wrong:Buffer.from('SPECIMEN-not-a-document'),jpeg:Buffer.from([0xff,0xd8,0xff,0,0xff,0xd9]),
  bytesInvalid:0,amount:500,currency:'CHF',contentType:'text/html',otherReference:'OTHER',stateFailure:409,inputFailure:400,unavailable:503,path:'case/proof.pdf'} as const;
const command={replacesProofId:null,requestId:fixture.requestId,expectedVersion:fixture.version,transferReference:fixture.reference,transferredOn:fixture.date};
const pdf={buffer:fixture.pdf,mimetype:P.mime.pdf,size:fixture.pdf.length};
const prepared=prepareRefundProof(pdf);
const asset:RefundProofAsset={id:fixture.id,caseId:fixture.id,sequence:O.revision.first,replacesProofId:null,organizationVersion:fixture.version,uploadedBy:fixture.id,requestId:fixture.requestId,
  requestFingerprint:refundProofFingerprint(command,prepared),amount:fixture.amount,currency:fixture.currency,transferReference:fixture.reference,transferredOn:fixture.date,
  objectPath:fixture.path,contentType:P.mime.pdf,byteSize:fixture.pdf.length,sha256:prepared.sha256,state:P.state.submitted,submittedAt:fixture.now};
describe('Private external-refund evidence contract',()=>{
  it('accepts the exact PDF/JPEG bytes and hashes the immutable original without manufacturing financial confirmation',()=>{
    expect(prepared.bytes).toBe(fixture.pdf);expect(prepared.sha256).toBe(createHash('sha256').update(fixture.pdf).digest('hex'));
    expect(prepareRefundProof({buffer:fixture.jpeg,mimetype:P.mime.jpeg,size:fixture.jpeg.length}).contentType).toBe('image/jpeg');
    expect(Object.values(P.state)).toEqual(['pending','submitted']);
    expect(presentRefundProof(asset)).toEqual({id:fixture.id,sequence:1,status:'submitted',review:null,organizationVersion:fixture.version,amount:500,currency:'CHF',transferReference:fixture.reference,
      transferredOn:'2026-11-01',submittedAt:'2026-11-03T01:00:00.000Z',file:{contentType:'application/pdf',byteSize:fixture.pdf.length,sha256:prepared.sha256}});
    expect(()=>presentRefundProof({...asset,state:P.state.pending,submittedAt:null})).toThrow();
  });
  it.each([undefined,{...pdf,size:fixture.bytesInvalid},{...pdf,mimetype:fixture.contentType},{...pdf,mimetype:P.mime.jpeg},
    {buffer:fixture.wrong,mimetype:P.mime.pdf,size:fixture.wrong.length},{...pdf,buffer:Buffer.alloc(P.file.maximumBytes+O.revision.step),size:P.file.maximumBytes+O.revision.step},
    {buffer:fixture.pdf.subarray(O.persistence.one),mimetype:P.mime.pdf,size:fixture.pdf.length-O.persistence.one}])('rejects missing, mismatched, unsupported or oversized files',file=>{
    expect(()=>prepareRefundProof(file)).toThrow(expect.objectContaining({status:fixture.inputFailure}));
  });
  it('normalizes multipart values once and rejects forged amount/currency and impossible dates',()=>{
    expect(refundProofCommandSchema.parse({...command,expectedVersion:fixture.version,transferReference:' '+fixture.reference+' '})).toEqual(command);
    for(const raw of [{...command,amount:fixture.amount},{...command,currency:fixture.currency},{...command,transferredOn:'2026-02-30'},{...command,expectedVersion:O.revision.absent},{...command,expectedVersion:true},{...command,replacesProofId:undefined}])expect(refundProofCommandSchema.safeParse(raw).success).toBe(false);
    expect(refundProofFingerprint({...command,transferReference:fixture.otherReference},prepared)).not.toBe(asset.requestFingerprint);
  });
  it('closes both instruction and customer editing after a submitted document',()=>{
    for(const scope of Object.values(O.scope))expect(organizationActions(scope,null,true)).toEqual([]);
  });
  it('rejects a future transfer date before reserving or uploading anything',async()=>{
    const repo={reserve:vi.fn(),submit:vi.fn(),receipt:vi.fn(),file:vi.fn(),history:vi.fn()},storage={uploadOrVerify:vi.fn(),download:vi.fn()},service=new RefundProofService(repo,storage);
    await expect(service.upload({scope:O.scope.brand,actorId:fixture.id},'return',fixture.id,{command:JSON.stringify({...command,transferredOn:fixture.future})},pdf)).rejects.toMatchObject({status:fixture.inputFailure});
    expect(repo.reserve).not.toHaveBeenCalled();expect(storage.uploadOrVerify).not.toHaveBeenCalled();
  });
  it('rechecks current access after storage download before returning the private document',async()=>{
    const repo={reserve:vi.fn(),submit:vi.fn(),receipt:vi.fn(),file:vi.fn().mockResolvedValueOnce(asset).mockRejectedValueOnce(new Error('revoked')),history:vi.fn()},storage={uploadOrVerify:vi.fn(),download:vi.fn(async()=>fixture.pdf)},service=new RefundProofService(repo,storage);
    await expect(service.file({scope:O.scope.brand,actorId:fixture.id},'return',fixture.id,fixture.id)).rejects.toThrow('revoked');expect(repo.file).toHaveBeenCalledTimes(2);
  });
  it('uses a private immutable object and verifies the stored bytes after a lost upload response',async()=>{
    const bucket={upload:vi.fn(async(path,bytes,options)=>{
      expect(path).toBe(fixture.path);expect(bytes).toEqual(fixture.pdf);expect(options).toEqual({contentType:'application/pdf',upsert:false,cacheControl:'0'});
      return {error:new Error('lost response')};
    }),download:vi.fn(async(path)=>{expect(path).toBe(fixture.path);return {error:null,data:new Blob([fixture.pdf])};})};
    const from=vi.fn((name)=>{expect(name).toBe('ufit-refund-proofs');return bucket;});
    const storage=new SupabaseRefundProofStorage(()=>({storage:{from}} as unknown as SupabaseClient));
    await storage.uploadOrVerify(asset,fixture.pdf);expect(bucket.download).toHaveBeenCalledExactlyOnceWith(fixture.path);
    bucket.download.mockResolvedValueOnce({error:null,data:new Blob([fixture.wrong])});
    await expect(storage.download(asset)).rejects.toMatchObject({status:fixture.unavailable});
    expect(from).not.toHaveBeenCalledWith(expect.stringContaining('public'));
  });
});
