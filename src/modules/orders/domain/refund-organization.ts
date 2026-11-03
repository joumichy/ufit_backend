import {createHash} from 'node:crypto';
import {BadRequestException, ConflictException, ForbiddenException} from '@nestjs/common';
import {z} from 'zod';
import {REFUND_RECOVERY, refundRecoveryKindSchema, type RefundRecoveryKind, type RefundRecoverySummary} from './refund-recovery.contract';

export const REFUND_ORGANIZATION = {
  repository: Symbol('RefundOrganizationRepository'),
  scope: {administrator: 'administrator', customer: 'customer', brand: 'brand'},
  status: {awaitingCustomer: 'awaiting_customer', ready: 'ready'},
  action: {arrange: 'arrange', provideDetails: 'provide_details'},
  revision: {absent: 0, first: 1, step: 1, maximum: 2147483647},
  text: {minimum: 1, method: 120, instructions: 4000, details: 2000},
  hash: {algorithm: 'sha256', encoding: 'hex', pattern: '^[a-f0-9]{64}$'},
  route: {admin: REFUND_RECOVERY.route.root, private: 'refund-recoveries', organization: ':kind/:id/organization', command: ':kind/:id/organization/commands/:requestId', requestId: 'requestId'},
  persistence: {lock: 'update', first: 0, one: 1},
  actor: {active: 'active', brandMemberRoles: ['owner', 'manager'] as const, brandStatuses: ['active', 'paused'] as const},
  failure: {
    input: {code: 'refund_organization_input_invalid', message: 'Invalid refund organization command'},
    changed: {code: 'refund_organization_changed', message: 'The refund arrangement changed; compare the current instructions before continuing'},
    replay: {code: 'refund_organization_request_reused', message: 'This request identity already describes another refund arrangement'},
    access: {code: 'refund_organization_access_denied', message: 'This refund arrangement is not available to this account'},
    persisted: {code: 'refund_organization_persisted_invalid', message: 'The recorded refund arrangement is inconsistent'},
    receipt: {code: 'refund_organization_receipt_missing', message: 'This request has not been recorded'},
  },
} as const;
export type RefundOrganizationScope = typeof REFUND_ORGANIZATION.scope[keyof typeof REFUND_ORGANIZATION.scope];
export type RefundOrganizationStatus = typeof REFUND_ORGANIZATION.status[keyof typeof REFUND_ORGANIZATION.status];
export type RefundOrganizationAction = typeof REFUND_ORGANIZATION.action[keyof typeof REFUND_ORGANIZATION.action];
const baseCommand = {requestId: z.uuid(), expectedVersion: z.number().int().min(REFUND_ORGANIZATION.revision.absent).max(REFUND_ORGANIZATION.revision.maximum - REFUND_ORGANIZATION.revision.step)};
export const refundOrganizationCommandSchema = z.discriminatedUnion('action', [
  z.object({...baseCommand, action: z.literal(REFUND_ORGANIZATION.action.arrange), methodLabel: z.string().trim().min(REFUND_ORGANIZATION.text.minimum).max(REFUND_ORGANIZATION.text.method), instructions: z.string().trim().min(REFUND_ORGANIZATION.text.minimum).max(REFUND_ORGANIZATION.text.instructions)}).strict(),
  z.object({...baseCommand, action: z.literal(REFUND_ORGANIZATION.action.provideDetails), details: z.string().trim().min(REFUND_ORGANIZATION.text.minimum).max(REFUND_ORGANIZATION.text.details)}).strict(),
]);
export type RefundOrganizationCommand = z.infer<typeof refundOrganizationCommandSchema>;
export const refundOrganizationReferenceSchema = z.object({kind: refundRecoveryKindSchema, id: z.uuid()}).strict();
export const refundOrganizationScopeSchema = z.object({scope: z.enum([REFUND_ORGANIZATION.scope.customer, REFUND_ORGANIZATION.scope.brand])}).strict();
export const refundOrganizationSchema = z.object({
  version: z.number().int().min(REFUND_ORGANIZATION.revision.first).max(REFUND_ORGANIZATION.revision.maximum),
  status: z.enum(Object.values(REFUND_ORGANIZATION.status)),
  methodLabel: z.string().trim().min(REFUND_ORGANIZATION.text.minimum).max(REFUND_ORGANIZATION.text.method),
  instructions: z.string().trim().min(REFUND_ORGANIZATION.text.minimum).max(REFUND_ORGANIZATION.text.instructions),
  customerDetails: z.string().trim().min(REFUND_ORGANIZATION.text.minimum).max(REFUND_ORGANIZATION.text.details).nullable(),
  updatedAt: z.iso.datetime(),
}).strict().refine(value => (value.status === REFUND_ORGANIZATION.status.awaitingCustomer) === (value.customerDetails === null));
export type RefundOrganization = z.infer<typeof refundOrganizationSchema>;
export interface RefundOrganizationDocument {summary: RefundRecoverySummary; organization: RefundOrganization | null; actions: RefundOrganizationAction[];}
export interface RefundOrganizationReceipt {requestId: string; version: number;}
export interface RefundOrganizationResult {document: RefundOrganizationDocument; receipt: RefundOrganizationReceipt;}
export interface RefundOrganizationAccess {scope: RefundOrganizationScope; actorId: string;}
export interface RefundOrganizationReference {kind: RefundRecoveryKind; id: string;}
export interface RefundOrganizationRepository {
  read(access: RefundOrganizationAccess, reference: RefundOrganizationReference): Promise<RefundOrganizationDocument>;
  apply(access: RefundOrganizationAccess, reference: RefundOrganizationReference, command: RefundOrganizationCommand): Promise<RefundOrganizationResult>;
  receipt(access: RefundOrganizationAccess, reference: RefundOrganizationReference, requestId: string): Promise<RefundOrganizationResult | undefined>;
}
export function organizationActions(scope: RefundOrganizationScope, organization: RefundOrganization | null): RefundOrganizationAction[] {
  if (organization && organization.version >= REFUND_ORGANIZATION.revision.maximum) return [];
  if (scope === REFUND_ORGANIZATION.scope.administrator) return [REFUND_ORGANIZATION.action.arrange];
  return scope === REFUND_ORGANIZATION.scope.customer && organization !== null ? [REFUND_ORGANIZATION.action.provideDetails] : [];
}
export function applyOrganization(current: RefundOrganization | null, scope: RefundOrganizationScope, command: RefundOrganizationCommand, now: string): RefundOrganization {
  if (!organizationActions(scope, current).includes(command.action)) throw new ForbiddenException(REFUND_ORGANIZATION.failure.access);
  const version = current?.version ?? REFUND_ORGANIZATION.revision.absent;
  if (version !== command.expectedVersion) throw new ConflictException(REFUND_ORGANIZATION.failure.changed);
  if (command.action === REFUND_ORGANIZATION.action.arrange) return {version: version + REFUND_ORGANIZATION.revision.step, status: REFUND_ORGANIZATION.status.awaitingCustomer, methodLabel: command.methodLabel, instructions: command.instructions, customerDetails: null, updatedAt: now};
  if (!current) throw new BadRequestException(REFUND_ORGANIZATION.failure.input);
  return {...current, version: version + REFUND_ORGANIZATION.revision.step, status: REFUND_ORGANIZATION.status.ready, customerDetails: command.details, updatedAt: now};
}
export function organizationFingerprint(command: RefundOrganizationCommand): string {
  return createHash(REFUND_ORGANIZATION.hash.algorithm).update(JSON.stringify(command)).digest(REFUND_ORGANIZATION.hash.encoding);
}
