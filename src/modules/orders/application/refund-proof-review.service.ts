import {createHash} from 'node:crypto';
import {BadRequestException,Inject,Injectable,NotFoundException} from '@nestjs/common';
import {z} from 'zod';
import {REFUND_ORGANIZATION as O,refundOrganizationReferenceSchema,type RefundOrganizationAccess} from '../domain/refund-organization';
import {REFUND_PROOF as P,type RefundProofStorage} from '../domain/refund-proof.contract';
import {REFUND_PROOF_REVIEW as R,refundProofReviewCommandSchema,type RefundProofReviewRepository,type RefundVerifiedFile} from '../domain/refund-proof-review';

@Injectable()
export class RefundProofReviewService {
  constructor(@Inject(R.repository) private readonly reviews:RefundProofReviewRepository,@Inject(P.storage) private readonly storage:RefundProofStorage) {}
  async review(access:RefundOrganizationAccess,kind:string,id:string,raw:unknown) {
    const parsed=refundProofReviewCommandSchema.safeParse(raw),reference=this.reference(kind,id);
    if(!parsed.success)throw new BadRequestException(R.failure.input);
    const command=parsed.data,preparation=await this.reviews.prepare(access,reference,command);
    if(preparation.kind===R.stage.recorded)return preparation.result;
    let verified:RefundVerifiedFile|null=null;
    if(command.decision===R.decision.confirm){
      const bytes=await this.storage.download(preparation.asset);
      verified={sha256:createHash(O.hash.algorithm).update(bytes).digest(O.hash.encoding),byteSize:bytes.length};
    }
    return this.reviews.review(access,reference,command,verified);
  }
  async receipt(access:RefundOrganizationAccess,kind:string,id:string,requestId:string) {
    if(!z.uuid().safeParse(requestId).success)throw new BadRequestException(R.failure.input);
    const result=await this.reviews.receipt(access,this.reference(kind,id),requestId);
    if(!result)throw new NotFoundException(R.failure.receipt);
    return result;
  }
  private reference(kind:string,id:string) {
    const reference=refundOrganizationReferenceSchema.safeParse({kind,id});
    if(!reference.success)throw new BadRequestException(R.failure.input);
    return reference.data;
  }
}
