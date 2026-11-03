import {REFUND_PROOF_REVIEW as RReview,refundProofReviewSchema,type RefundProofReview} from './refund-proof-review';
import {createHash} from 'node:crypto';
import {BadRequestException, ConflictException} from '@nestjs/common';
import {z} from 'zod';
import type {RefundOrganizationAccess, RefundOrganizationReference} from './refund-organization';
import {REFUND_ORGANIZATION as O} from './refund-organization';
import {REFUND_RECOVERY as R} from './refund-recovery.contract';
import {IMAGE_UPLOAD} from '../../media/domain/image-upload.contract';

export const REFUND_PROOF = {
  repository: Symbol('RefundProofRepository'), storage: Symbol('RefundProofStorage'),
  bucket: 'ufit-refund-proofs', state: {pending: 'pending', submitted: 'submitted'},
  mime: {pdf: 'application/pdf', jpeg: IMAGE_UPLOAD.mime}, extension: {pdf: '.pdf', jpeg: IMAGE_UPLOAD.extension},
  file: {maximumBytes: 8 * 1024 * 1024, minimumBytes: 5, first: 0, pdfPrefix: '%PDF-', pdfEnd: '%%EOF', pdfTailBytes: 1024, encoding: 'ascii' as const},
  text: {minimum: 1, referenceMaximum: 160}, amount: {minimum: 1}, currencyPattern: '^[A-Z]{3}$',
  multipart: {file: 'file', command: 'command', files: 1, fields: 1},
  route: {upload: ':kind/:id/proofs', receipt: ':kind/:id/proofs/commands/:requestId', file: ':kind/:id/proofs/:proofId/file', proofId: 'proofId'},
  storageSettings: {upsert: false, cacheControl: '0', separator: '/'},
  download: {cacheHeader: 'Cache-Control', cacheValue: 'private, no-store', typeHeader: 'Content-Type', sizeHeader: 'Content-Length'},
  failure: {
    input: {code: 'refund_proof_input_invalid', message: 'Invalid refund proof declaration or file'},
    unavailable: {code: 'refund_proof_storage_unavailable', message: 'The private refund document is temporarily unavailable'},
    configuration: {code: 'refund_proof_storage_unconfigured', message: 'Private refund document storage is unavailable'},
    state: {code: 'refund_proof_state_changed', message: 'The refund instructions or document changed; reload the case'},
    missing: {code: 'refund_proof_not_found', message: 'This refund document is not available'},
    receipt: {code: 'refund_proof_receipt_missing', message: 'This refund document request has not been recorded'},
    replay: {code: 'refund_proof_request_reused', message: 'This request already describes another refund document'},
    persisted: {code: 'refund_proof_persisted_invalid', message: 'The recorded refund document is inconsistent'},
  },
} as const;
const P = REFUND_PROOF;
export const refundProofCommandSchema = z.object({requestId: z.uuid(), expectedVersion: z.number().int().min(O.revision.first).max(O.revision.maximum), replacesProofId: z.uuid().nullable(),
  transferReference: z.string().trim().min(P.text.minimum).max(P.text.referenceMaximum), transferredOn: z.iso.date()}).strict();
export const refundProofMultipartSchema=z.object({command:z.string().min(P.text.minimum)}).strict();
export const refundProofHistoryQuerySchema=z.object({limit:z.coerce.number().int().min(RReview.history.minimumLimit).max(RReview.history.maximumLimit).default(RReview.history.defaultLimit),cursor:z.uuid().optional()}).strict();
export type RefundProofCommand = z.infer<typeof refundProofCommandSchema>;
export const refundProofMetadataSchema = z.object({id: z.uuid(), sequence: z.number().int().min(O.revision.first).max(O.revision.maximum), status: z.enum(Object.values(RReview.status)), review: refundProofReviewSchema.nullable(), organizationVersion: z.number().int().min(O.revision.first).max(O.revision.maximum),
  amount: z.number().int().min(P.amount.minimum).max(R.amount.maximum), currency: z.string().regex(new RegExp(P.currencyPattern)),
  transferReference: z.string().trim().min(P.text.minimum).max(P.text.referenceMaximum), transferredOn: z.iso.date(), submittedAt: z.iso.datetime(),
  file: z.object({contentType: z.enum(Object.values(P.mime)), byteSize: z.number().int().min(P.file.minimumBytes).max(P.file.maximumBytes), sha256: z.string().regex(new RegExp(O.hash.pattern))}).strict(),
}).strict().refine(value => (value.status===RReview.status.submitted && value.review===null)
  || (value.status===RReview.status.rejected && value.review?.decision===RReview.decision.reject)
  || (value.status===RReview.status.verified && value.review?.decision===RReview.decision.confirm));
export type RefundProofMetadata = z.infer<typeof refundProofMetadataSchema>;
export interface RefundProofFile {buffer: Buffer; mimetype: string; size: number;}
export interface PreparedRefundProof {bytes: Buffer; contentType: RefundProofMetadata['file']['contentType']; sha256: string;}
export interface RefundProofAsset {
  id: string; caseId: string; sequence: number; replacesProofId: string | null; organizationVersion: number; uploadedBy: string | null; requestId: string; requestFingerprint: string;
  amount: number; currency: string; transferReference: string; transferredOn: string; objectPath: string;
  contentType: RefundProofMetadata['file']['contentType']; byteSize: number; sha256: string;
  state: typeof P.state[keyof typeof P.state]; submittedAt: Date | null;
}
export interface RefundProofReceipt {requestId: string; state: RefundProofAsset['state']; proof: RefundProofMetadata | null;}
export interface RefundProofRepository {
  reserve(access: RefundOrganizationAccess, reference: RefundOrganizationReference, command: RefundProofCommand, file: PreparedRefundProof): Promise<RefundProofAsset>;
  submit(access: RefundOrganizationAccess, reference: RefundOrganizationReference, asset: RefundProofAsset): Promise<RefundProofReceipt>;
  receipt(access: RefundOrganizationAccess, reference: RefundOrganizationReference, requestId: string): Promise<RefundProofReceipt | undefined>;
  file(access: RefundOrganizationAccess, reference: RefundOrganizationReference, proofId: string): Promise<RefundProofAsset>;
  history(access: RefundOrganizationAccess, reference: RefundOrganizationReference, query: {limit:number;cursor?:string}): Promise<{items:RefundProofMetadata[];nextCursor:string|null}>;
}
export interface RefundProofStorage {
  uploadOrVerify(asset: RefundProofAsset, bytes: Buffer): Promise<void>;
  download(asset: RefundProofAsset): Promise<Buffer>;
}
export function prepareRefundProof(file: RefundProofFile | undefined): PreparedRefundProof {
  if (!file || !Buffer.isBuffer(file.buffer) || file.size !== file.buffer.length || file.size < P.file.minimumBytes || file.size > P.file.maximumBytes) throw new BadRequestException(P.failure.input);
  const bytes = file.buffer;
  const jpeg = file.mimetype === P.mime.jpeg && IMAGE_UPLOAD.image.prefix.every((value,index) => bytes[index] === value)
    && IMAGE_UPLOAD.image.suffix.every((value,index) => bytes[bytes.length - IMAGE_UPLOAD.image.suffix.length + index] === value);
  const pdf = file.mimetype === P.mime.pdf && bytes.subarray(P.file.first,P.file.pdfPrefix.length).toString(P.file.encoding) === P.file.pdfPrefix
    && bytes.subarray(-P.file.pdfTailBytes).toString(P.file.encoding).trimEnd().endsWith(P.file.pdfEnd);
  if (!jpeg && !pdf) throw new BadRequestException(P.failure.input);
  return {bytes, contentType: jpeg ? P.mime.jpeg : P.mime.pdf, sha256: createHash(O.hash.algorithm).update(bytes).digest(O.hash.encoding)};
}
export function refundProofFingerprint(command: RefundProofCommand, file: PreparedRefundProof): string {
  return createHash(O.hash.algorithm).update(JSON.stringify([command.requestId,String(command.expectedVersion),command.replacesProofId,command.transferReference,command.transferredOn,file.contentType,String(file.bytes.length),file.sha256])).digest(O.hash.encoding);
}
export function presentRefundProof(asset: RefundProofAsset, review: RefundProofReview | null = null): RefundProofMetadata {
  if (asset.state !== P.state.submitted || !asset.submittedAt) throw new ConflictException(P.failure.persisted);
  const status=review===null?RReview.status.submitted:review.decision===RReview.decision.reject?RReview.status.rejected:RReview.status.verified;
  const parsed=refundProofMetadataSchema.safeParse({id:asset.id,sequence:asset.sequence,status,review,organizationVersion:asset.organizationVersion,amount:asset.amount,currency:asset.currency,
    transferReference:asset.transferReference,transferredOn:asset.transferredOn,submittedAt:asset.submittedAt.toISOString(),file:{contentType:asset.contentType,byteSize:asset.byteSize,sha256:asset.sha256}});
  if (!parsed.success) throw new ConflictException(P.failure.persisted);
  return parsed.data;
}
