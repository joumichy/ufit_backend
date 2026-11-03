import {BadRequestException,Inject,Injectable,NotFoundException} from '@nestjs/common';
import {z} from 'zod';
import {refundOrganizationReferenceSchema,type RefundOrganizationAccess} from '../domain/refund-organization';
import {REFUND_PROOF as P,prepareRefundProof,refundProofCommandSchema,refundProofMultipartSchema,refundProofHistoryQuerySchema,type RefundProofFile,type RefundProofRepository,type RefundProofStorage} from '../domain/refund-proof.contract';

@Injectable()
export class RefundProofService {
  constructor(@Inject(P.repository) private readonly proofs:RefundProofRepository,@Inject(P.storage) private readonly storage:RefundProofStorage) {}
  async upload(access:RefundOrganizationAccess,kind:string,id:string,raw:unknown,file?:RefundProofFile) {
    const multipart=refundProofMultipartSchema.safeParse(raw);
    if(!multipart.success)throw new BadRequestException(P.failure.input);
    let decoded:unknown;
    try {decoded=JSON.parse(multipart.data.command);}catch {throw new BadRequestException(P.failure.input);}
    const command=refundProofCommandSchema.safeParse(decoded);
    if(!command.success || command.data.transferredOn>new Date().toISOString().slice(DatePart.start,DatePart.end))throw new BadRequestException(P.failure.input);
    const reference=this.reference(kind,id),prepared=prepareRefundProof(file);
    const asset=await this.proofs.reserve(access,reference,command.data,prepared);
    if(asset.state===P.state.pending)await this.storage.uploadOrVerify(asset,prepared.bytes);
    return this.proofs.submit(access,reference,asset);
  }
  async receipt(access:RefundOrganizationAccess,kind:string,id:string,requestId:string) {
    this.identity(requestId);
    const receipt=await this.proofs.receipt(access,this.reference(kind,id),requestId);
    if(!receipt)throw new NotFoundException(P.failure.receipt);
    return receipt;
  }
  history(access:RefundOrganizationAccess,kind:string,id:string,raw:unknown) {
    const query=refundProofHistoryQuerySchema.safeParse(raw);
    if(!query.success)throw new BadRequestException(P.failure.input);
    return this.proofs.history(access,this.reference(kind,id),query.data);
  }
  async file(access:RefundOrganizationAccess,kind:string,id:string,proofId:string) {
    this.identity(proofId);
    const asset=await this.proofs.file(access,this.reference(kind,id),proofId),bytes=await this.storage.download(asset);
    // Membership may change while private storage is being read.
    await this.proofs.file(access,this.reference(kind,id),proofId);
    return {bytes,contentType:asset.contentType};
  }
  private reference(kind:string,id:string) {
    const parsed=refundOrganizationReferenceSchema.safeParse({kind,id});
    if(!parsed.success)throw new BadRequestException(P.failure.input);
    return parsed.data;
  }
  private identity(value:string) {if(!z.uuid().safeParse(value).success)throw new BadRequestException(P.failure.input);}
}
const DatePart={start:0,end:10} as const;
