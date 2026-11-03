import {z} from 'zod';
import {PROFILE_STATUSES} from '../../../shared/domain/profile-editing.contract';
import {calculateCommissionAmount} from '../../commissions/domain/commission-rule.contract';

export const PAYMENT_DISTRIBUTION = {
  repository: Symbol('PaymentDistributionRepository'),
  route: {root: 'admin/payment-distribution', brands: 'brands', brand: 'brands/:brandId',
    history: 'brands/:brandId/history', change: 'brands/:brandId/changes/:requestId', brandId: 'brandId', requestId: 'requestId'},
  feeBearer: {brand: 'brand', platform: 'platform'},
  limits: {zero: 0, one: 1, basisPoints: 10_000, maximumAmount: 2_147_483_647, maximumRevision: 2_147_483_647,
    page: 20, maximumPage: 50, reason: 500, search: 120},
  request: {hashAlgorithm: 'sha256', hashEncoding: 'hex', hashPattern: /^[a-f0-9]{64}$/},
  query: {emptySearch: ''},
  cache: {header: 'Cache-Control', value: 'private, no-store'},
  lock: 'update',
  validation: {custom: 'custom', chain: 'Invalid distribution revision chain', page: 'Invalid distribution history order',
    reference: 'Distribution references do not match', textType: 'string'},
  failure: {
    access: {code: 'payment_distribution_access_required', message: 'Active administration access is required'},
    input: {code: 'payment_distribution_invalid', message: 'Invalid payment distribution request'},
    missing: {code: 'payment_distribution_brand_missing', message: 'Brand not found'},
    changed: {code: 'payment_distribution_changed', message: 'The distribution conditions changed; refresh before saving'},
    reused: {code: 'payment_distribution_request_reused', message: 'This request belongs to another distribution change'},
    receipt: {code: 'payment_distribution_change_missing', message: 'This distribution change has not been recorded'},
    persisted: {code: 'payment_distribution_persisted_invalid', message: 'The recorded distribution conditions require verification'},
    unavailable: {code: 'payment_distribution_unconfigured', message: 'Cette marque termine sa configuration de paiement. Réessayez plus tard.'},
    order: {code: 'payment_distribution_order_unconfigured', message: 'Cette commande doit être actualisée avant le paiement. Revenez à votre panier.'},
    budget: {code: 'payment_distribution_budget_invalid', message: 'Les conditions de cette marque doivent être corrigées avant le paiement.'},
  },
} as const;
const C = PAYMENT_DISTRIBUTION;
export const distributionIDSchema = z.uuid().toLowerCase();
const revision = z.number().int().min(C.limits.one).max(C.limits.maximumRevision);
const rate = z.number().int().min(C.limits.zero).max(C.limits.basisPoints);
export const distributionChangeSchema = z.object({
  requestId: distributionIDSchema, expectedRevision: z.number().int().min(C.limits.zero).max(C.limits.maximumRevision - C.limits.one), platformRateBps: rate,
  feeBearer: z.enum(Object.values(C.feeBearer)), active: z.boolean(),
  reason: z.string().trim().min(C.limits.one).max(C.limits.reason),
}).strict();
export type DistributionChange = z.infer<typeof distributionChangeSchema>;
export const distributionPageSchema = z.object({cursor: distributionIDSchema.optional(),
  limit: z.coerce.number().int().min(C.limits.one).max(C.limits.maximumPage).default(C.limits.page),
}).strict();
export const distributionBrandQuerySchema = distributionPageSchema.safeExtend({search: z.string().trim().max(C.limits.search).default(C.query.emptySearch)});
export type DistributionPageQuery = z.infer<typeof distributionPageSchema>;
export type DistributionBrandQuery = z.infer<typeof distributionBrandQuerySchema>;
export const distributionRevisionSchema = z.object({
  id: distributionIDSchema, brandId: distributionIDSchema, requestId: distributionIDSchema, revision,
  previousId: distributionIDSchema.nullable(), platformRateBps: rate, feeBearer: z.enum(Object.values(C.feeBearer)),
  active: z.boolean(), reason: z.string().trim().min(C.limits.one).max(C.limits.reason),
  createdAt: z.iso.datetime(), supersededAt: z.iso.datetime().nullable(),
}).strict().refine(value => (value.revision === C.limits.one) === (value.previousId === null)
  && (value.supersededAt === null || Date.parse(value.supersededAt) >= Date.parse(value.createdAt)), C.validation.chain);
export type DistributionRevision = z.infer<typeof distributionRevisionSchema>;
export const distributionBrandSchema = z.object({id: distributionIDSchema, name: z.string().trim().min(C.limits.one), status: z.enum(PROFILE_STATUSES)}).strict();
export type DistributionBrand = z.infer<typeof distributionBrandSchema>;
export const distributionDocumentSchema = z.object({brand: distributionBrandSchema, current: distributionRevisionSchema.nullable(), asOf: z.iso.datetime()})
  .strict().refine(value => value.current === null || value.current.brandId === value.brand.id && value.current.supersededAt === null, C.validation.reference);
export type DistributionDocument = z.infer<typeof distributionDocumentSchema>;
export const distributionResultSchema = z.object({receipt: distributionRevisionSchema, document: distributionDocumentSchema})
  .strict().refine(value => value.receipt.brandId === value.document.brand.id, C.validation.reference);
export type DistributionResult = z.infer<typeof distributionResultSchema>;
export const distributionBrandsSchema = z.object({
  items: z.array(z.object({brand: distributionBrandSchema, current: distributionRevisionSchema.nullable()}).strict()),
  nextCursor: distributionIDSchema.nullable(),
}).strict().refine(value => new Set(value.items.map(row => row.brand.id)).size === value.items.length
  && value.items.every(row => row.current === null || row.current.brandId === row.brand.id && row.current.supersededAt === null)
  && (value.nextCursor === null || value.nextCursor === value.items.at(-C.limits.one)?.brand.id), C.validation.page);
export type DistributionBrands = z.infer<typeof distributionBrandsSchema>;
export const distributionHistorySchema = z.object({brandId: distributionIDSchema, items: z.array(distributionRevisionSchema), nextCursor: distributionIDSchema.nullable()})
  .strict().refine(value => new Set(value.items.map(row => row.id)).size === value.items.length
    && value.items.every((row, index) => row.brandId === value.brandId && (index === C.limits.zero || row.revision === value.items[index - C.limits.one].revision - C.limits.one))
    && (value.nextCursor === null || value.nextCursor === value.items.at(-C.limits.one)?.id), C.validation.page);
export type DistributionHistory = z.infer<typeof distributionHistorySchema>;
export class DistributionBudgetExceeded extends Error {
  constructor() { super(C.failure.budget.code); }
}
export function platformCommissionAmount(subtotal: number, creatorCommission: number, platformRateBps: number): number {
  const money = z.number().int().min(C.limits.zero).max(C.limits.maximumAmount);
  money.parse(subtotal); money.parse(creatorCommission);
  const amount = calculateCommissionAmount(subtotal, rate.parse(platformRateBps));
  if (BigInt(amount) + BigInt(creatorCommission) > BigInt(subtotal)) throw new DistributionBudgetExceeded();
  return amount;
}
