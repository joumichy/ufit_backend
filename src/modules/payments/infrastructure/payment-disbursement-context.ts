import {ConflictException} from '@nestjs/common';
import {and, eq, inArray, sql} from 'drizzle-orm';
import {z} from 'zod';
import type {DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {orders, payments, brandProfiles, creatorProfiles, brandMembers, commissions, paymentRefundJobs} from '../../../shared/infrastructure/database/schema';
import {PROFILE_AUTHOR_ROLES, PROFILE_EDITING, PROFILE_STATUS} from '../../../shared/domain/profile-editing.contract';
import {USER_ADMINISTRATION as U} from '../../identity/domain/user-administration.contract';
import {findIdentityAccess, IdentityAccessMode} from '../../identity/infrastructure/persistence/identity-access';
import {COMMISSION_RELEASE, commissionReleaseSchema} from '../../commissions/domain/commission-release';
import {commissionFinancialFacts} from '../../commissions/infrastructure/commission-financial-facts.sql';
import {ORDER_PAYMENT} from '../../orders/domain/order-lifecycle';
import {CONNECT, type ConnectAccountRecord} from '../domain/connect-account';
import {PAYMENT_TRANSFER as T, type TransferReason} from '../domain/payment-transfer';
import {PAYMENT_DISBURSEMENT as C, calculateDisbursement, type DisbursementBasis, type DisbursementAssessment} from '../domain/payment-disbursement';
import {allocationRecipientKey, PAYMENT_ALLOCATION, type StoredAllocationPlan} from '../domain/payment-allocation';
import {DrizzlePaymentAllocationsRepository} from './drizzle-payment-allocations.repository';
import {DrizzleRefundSettlementsRepository} from './drizzle-refund-settlements.repository';
import {DrizzleConnectAccountsRepository} from './drizzle-connect-accounts.repository';
import {readDisbursementBusiness} from './payment-disbursement-business';

import type {DisbursementAvailability, DisbursementContext} from '../domain/payment-disbursement.repository';
const factSchema = z.object({id: z.uuid(), orderItemId: z.uuid(), releaseState: z.enum(Object.values(COMMISSION_RELEASE.state)),
  availableAt: z.iso.datetime().nullable(), invalid: z.literal(false), returnOpen: z.boolean(), cancellationOpen: z.boolean()}).strict();

/** The execution caller locks the order and its owners before requesting this final view. */
export async function readDisbursementContext(database: DatabaseSession, paymentId: string, lock: boolean): Promise<DisbursementContext | undefined> {
  const plan = await new DrizzlePaymentAllocationsRepository(database).storedPlan(paymentId);
  if (!plan) return undefined;
  const orderQuery = database.db.select().from(orders).where(eq(orders.id, plan.orderId));
  const [order] = await (lock ? orderQuery.for(PAYMENT_ALLOCATION.lock) : orderQuery);
  const [payment] = await database.db.select().from(payments).where(eq(payments.id, paymentId));
  if (!order || !payment || payment.orderId !== order.id || order.brandId !== plan.brandId || payment.provider !== ORDER_PAYMENT.provider
    || payment.providerPaymentIntentId !== order.stripePaymentIntentId || payment.amount !== plan.presentmentAmount || payment.currency !== plan.presentmentCurrency
    || order.totalAmount !== plan.presentmentAmount || order.currency !== plan.presentmentCurrency) throw new ConflictException(C.reason.sources);
  if (lock) await database.db.select({id: paymentRefundJobs.paymentId}).from(paymentRefundJobs).where(eq(paymentRefundJobs.paymentId, paymentId)).for(PAYMENT_ALLOCATION.lock);
  const refunds = await new DrizzleRefundSettlementsRepository(database).document(paymentId);
  if (!refunds) throw new ConflictException(C.reason.sources);
  const business = await readDisbursementBusiness(database, order, plan);
  const {openReturnItemIds, cancellationOpen, ...economics} = business;
  const basis: DisbursementBasis = {plan, refunds, ...economics};
  const assessment = calculateDisbursement(basis);
  const rawFacts = await database.db.execute(sql`${commissionFinancialFacts({kind: COMMISSION_RELEASE.scope.administration})}
    select id,order_item_id as "orderItemId",release_state as "releaseState",available_at as "availableAt",invalid,
      return_open as "returnOpen",cancellation_open as "cancellationOpen" from facts where order_id=${order.id}`);
  const facts = rawFacts.rows.map(row => factSchema.parse(row));
  const originals = facts.length ? await database.db.select({id: commissions.id, creatorId: commissions.creatorId}).from(commissions)
    .where(inArray(commissions.id, facts.map(row => row.id))) : [];
  const expected = plan.lines.filter(line => line.recipient.kind === PAYMENT_ALLOCATION.kind.creator);
  if (expected.length !== facts.length || expected.some(line => {
    const recipient = line.recipient;
    return recipient.kind === PAYMENT_ALLOCATION.kind.creator && !facts.some(row => row.id === recipient.commissionId);
  })) throw new ConflictException(C.reason.sources);
  const [brand] = await database.db.select().from(brandProfiles).where(eq(brandProfiles.id, plan.brandId));
  if (!brand) throw new ConflictException(C.reason.sources);
  const ownerAccess = await findIdentityAccess(database, brand.ownerUserId, IdentityAccessMode.Read);
  const [member] = await database.db.select({id: brandMembers.id}).from(brandMembers).where(and(eq(brandMembers.brandProfileId, brand.id),
    eq(brandMembers.userId, brand.ownerUserId), eq(brandMembers.role, CONNECT.ownerRole), eq(brandMembers.status, PROFILE_EDITING.persistence.memberActive)));
  const brandActive = brand.status === PROFILE_STATUS.active && member !== undefined && ownerAccess?.status === U.status.active
    && ownerAccess.roles.includes(PROFILE_AUTHOR_ROLES.brandOwner);
  const accounts = new DrizzleConnectAccountsRepository(database), availability: DisbursementAvailability[] = [];
  const brandAccount = await accounts.find({kind: CONNECT.kind.brand, profileId: brand.id}, refunds.source.capture.liveMode);
  const creatorIds = [...new Set(expected.flatMap(line => line.recipient.kind === PAYMENT_ALLOCATION.kind.creator ? [line.recipient.beneficiaryId] : []))];
  const profiles = creatorIds.length ? await database.db.select().from(creatorProfiles).where(inArray(creatorProfiles.id, creatorIds)) : [];
  const creatorStates = new Map<string, {active: boolean; account: ConnectAccountRecord | null}>();
  for (const profileId of creatorIds) {
    const profile = profiles.find(row => row.id === profileId);
    const access = profile ? await findIdentityAccess(database, profile.userId, IdentityAccessMode.Read) : undefined;
    const active = profile !== undefined && profile.status === PROFILE_STATUS.active && access?.status === U.status.active && access.roles.includes(PROFILE_AUTHOR_ROLES.creator);
    const account = await accounts.find({kind: CONNECT.kind.creator, profileId}, refunds.source.capture.liveMode);
    creatorStates.set(profileId, {active, account});
  }
  for (const line of plan.lines) {
    const recipient = line.recipient;
    if (recipient.kind === PAYMENT_ALLOCATION.kind.platform) continue;
    const creatorState = recipient.kind === PAYMENT_ALLOCATION.kind.creator ? creatorStates.get(recipient.beneficiaryId) : undefined;
    if (recipient.kind === PAYMENT_ALLOCATION.kind.creator && creatorState === undefined) throw new ConflictException(C.reason.sources);
    const account = recipient.kind === PAYMENT_ALLOCATION.kind.brand ? brandAccount : creatorState!.account;
    let reason: TransferReason | null = null, availableAt: string | null = null;
    let releaseState: DisbursementAvailability['releaseState'] = null;
    if (recipient.kind === PAYMENT_ALLOCATION.kind.brand) {
      if (!brandActive) reason = T.reason.profile;
      else if (cancellationOpen || business.refundOutstanding) reason = T.reason.cancellation;
      else if (openReturnItemIds.size > C.zero) reason = T.reason.returnOpen;
    } else {
      const profileId = recipient.beneficiaryId;
      const fact = facts.find(row => row.id === recipient.commissionId);
      const original = originals.find(row => row.id === recipient.commissionId);
      if (!fact || !original || !creatorState || original.creatorId !== profileId) throw new ConflictException(C.reason.sources);
      const release = commissionReleaseSchema.parse({state: fact.releaseState, availableAt: fact.availableAt}); availableAt = release.availableAt; releaseState = release.state;
      if (!creatorState.active) reason = T.reason.profile;
      else if (fact.cancellationOpen || cancellationOpen) reason = T.reason.cancellation;
      else if (fact.returnOpen || openReturnItemIds.has(fact.orderItemId)) reason = T.reason.returnOpen;
      else if (release.state === COMMISSION_RELEASE.state.returnWindow) reason = T.reason.returnWindow;
      else if (release.state !== COMMISSION_RELEASE.state.payable && release.state !== COMMISSION_RELEASE.state.paid) reason = T.reason.delivery;
    }
    if (reason === null && (account === null || account.stripeAccountId === null)) reason = T.reason.account;
    if (reason === null && assessment.phase !== C.phase.settled) reason = T.reason.adjustment;
    if (reason === null && assessment.phase !== C.phase.review && assessment.lines.some(row => row.netAmount < C.zero)) reason = T.reason.adjustment;
    availability.push({key: allocationRecipientKey(recipient), releaseState, allowed: reason === null, reason, availableAt, account});
  }
  return {plan, basis, assessment, availability};
}
