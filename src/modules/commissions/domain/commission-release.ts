import {z} from 'zod';
import {ORDER_COMMISSION} from '../../orders/domain/order-lifecycle';

export const COMMISSION_RELEASE = {
  state: {
    estimated: 'estimated', awaitingDelivery: 'awaiting_delivery', returnWindow: 'return_window',
    returnOpen: 'return_open', cancellationOpen: 'cancellation_open', payable: 'payable', paid: 'paid', cancelled: 'cancelled',
  },
  snapshot: {window: 'returnWindowDays', number: 'number'},
  scope: {creator: 'creator', administration: 'administration'},
  time: {millisecondsPerSecond: 1000, latestTimestamp: 253402300799999},
  windowPattern: '^(0|[1-9][0-9]*)$',
  validation: {code: 'custom', dateRequired: 'A dated commission release is required', noDate: 'This release state has no availability date'},
} as const;
export const commissionReleaseSchema = z.object({
  state: z.enum(Object.values(COMMISSION_RELEASE.state)),
  availableAt: z.iso.datetime().nullable(),
}).strict().superRefine((value, context) => {
  const state = COMMISSION_RELEASE.state;
  if ([state.returnWindow, state.payable].some(item => item === value.state) && value.availableAt === null) {
    context.addIssue({code: COMMISSION_RELEASE.validation.code, message: COMMISSION_RELEASE.validation.dateRequired});
  }
  if ([state.estimated, state.awaitingDelivery, state.paid, state.cancelled].some(item => item === value.state) && value.availableAt !== null) {
    context.addIssue({code: COMMISSION_RELEASE.validation.code, message: COMMISSION_RELEASE.validation.noDate});
  }
});
export type CommissionRelease = z.infer<typeof commissionReleaseSchema>;
export type CommissionFinancialScope = {kind: typeof COMMISSION_RELEASE.scope.creator; creatorId: string}
  | {kind: typeof COMMISSION_RELEASE.scope.administration};
export function commissionReleaseStatus(release: CommissionRelease): typeof ORDER_COMMISSION.status[keyof typeof ORDER_COMMISSION.status] {
  switch (release.state) {
    case COMMISSION_RELEASE.state.estimated: return ORDER_COMMISSION.status.estimated;
    case COMMISSION_RELEASE.state.paid: return ORDER_COMMISSION.status.paid;
    case COMMISSION_RELEASE.state.cancelled: return ORDER_COMMISSION.status.cancelled;
    case COMMISSION_RELEASE.state.payable: return ORDER_COMMISSION.status.validated;
    case COMMISSION_RELEASE.state.awaitingDelivery:
    case COMMISSION_RELEASE.state.returnWindow:
    case COMMISSION_RELEASE.state.returnOpen:
    case COMMISSION_RELEASE.state.cancellationOpen: return ORDER_COMMISSION.status.pending;
  }
}
