import {APPLICATION} from '../../applications/types/application-contract';

// Only profile applications require approval; published content is supervised afterwards.
export const ADMIN_ACTIVITY = {
  route: 'activity', summaries: 'summaries', queues: 'queues/:queue', queueParam: 'queue',
  roles: ['admin', 'super_admin'],
  applicationStatuses: [APPLICATION.status.submitted, APPLICATION.status.underReview],
  minimumCount: 0,
  invalid: 'Invalid administration counters',
} as const;
export const ADMIN_QUEUE = {
  kind: {applications: 'applications', orders: 'orders', commissions: 'commissions'},
  page: {default: 20, maximum: 50, minimum: 1, zero: 0},
  invalid: 'Unknown admin queue',
} as const;
export interface AdminActivity { applications: number; }
