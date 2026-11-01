import {z} from 'zod';

export const COMMISSION_RULE = {
  token: {repository: 'CommissionRuleRepository', resolver: 'CommissionRuleResolver', commissions: 'CommissionRepository'},
  route: {admin: 'admin/commission-rules', scope: ':scopeId', history: ':scopeId/history', revisions: ':scopeId/revisions', scopeId: 'scopeId', options: 'options/:kind', optionKind: 'kind', quote: 'quote-rate', root: 'commissions'},
  roles: ['admin', 'super_admin'],
  quoteRoles: ['brand_owner', 'brand_manager', 'admin', 'super_admin'],
  status: {activeUser: 'active', activeCreator: 'active'},
  limits: {zero: 0, basisPoints: 10_000, decimalPlaces: 4, storagePrecision: 5, halfDivisor: 2, initialRevision: 1, increment: 1, singleRow: 1, firstRow: 0, page: 20, maximumPage: 100, reason: 500},
  specificity: {product: 2, grade: 1, generic: 0},
  lock: 'update',
  failure: {
    input: 'Les paramètres de commission sont invalides.', access: 'Cet accès est réservé à une administration active.',
    missing: 'Cette règle de commission est introuvable.', scope: 'Une règle existe déjà pour cette marque, cet article et ce grade.',
    changed: 'Cette règle a changé. Rechargez-la avant de réessayer.', reference: 'La marque, le grade ou l’article sélectionné est invalide.',
    cursor: 'La page de règles demandée est invalide.', persisted: 'Les données de commission enregistrées sont incohérentes.',
    unavailable: 'La commission de cet article doit être configurée par Ufit avant l’achat.',
    creator: 'Le créateur de cet article n’est plus disponible.', amount: 'Le montant de commission est invalide.'
  },
  ratePattern: /^(0\.\d{4}|1\.0000)$/,
  decimalSeparator: '.', zeroDigit: '0',
} as const;

const bps = z.number().int().min(COMMISSION_RULE.limits.zero).max(COMMISSION_RULE.limits.basisPoints);
export const commissionRateSchema = z.object({baseRateBps: bps, bonusRateBps: bps, maxRateBps: bps.nullable()}).strict();
export type CommissionRateInput = z.infer<typeof commissionRateSchema>;
const configuration = {...commissionRateSchema.shape, active: z.boolean(), reason: z.string().trim().min(COMMISSION_RULE.limits.singleRow).max(COMMISSION_RULE.limits.reason)};
export const createCommissionRuleSchema = z.object({brandId: z.uuid(), productId: z.uuid().nullable(), creatorGradeCode: z.string().min(COMMISSION_RULE.limits.singleRow).nullable(), ...configuration}).strict();
export const reviseCommissionRuleSchema = z.object({expectedRevision: z.number().int().min(COMMISSION_RULE.limits.initialRevision), ...configuration}).strict();
export const commissionRulePageSchema = z.object({brandId: z.uuid().optional(), cursor: z.uuid().optional(), limit: z.coerce.number().int().min(COMMISSION_RULE.limits.singleRow).max(COMMISSION_RULE.limits.maximumPage).default(COMMISSION_RULE.limits.page)}).strict();
export type CreateCommissionRule = z.infer<typeof createCommissionRuleSchema>;
export type ReviseCommissionRule = z.infer<typeof reviseCommissionRuleSchema>;
export type CommissionRuleQuery = z.infer<typeof commissionRulePageSchema>;
export interface CommissionRuleRevision extends CommissionRateInput {
  id: string; scopeId: string; revision: number; previousRuleId: string | null;
  brandId: string; productId: string | null; creatorGradeCode: string | null;
  brandName: string; productName: string | null; creatorGradeLabel: string | null;
  active: boolean; rateBps: number; reason: string | null; createdByUserId: string | null;
  createdAt: string; supersededAt: string | null;
}
export interface ResolvedCommissionRule {id: string; creatorGradeCode: string; rateBps: number;}
export interface CommissionRuleResolver {
  resolve(input: {brandId: string; productId: string; creatorId: string}): Promise<ResolvedCommissionRule>;
}
export interface CommissionRulePage {items: CommissionRuleRevision[]; nextCursor: string | null;}

export function calculateRateBps(input: CommissionRateInput): number {
  const rate = commissionRateSchema.parse(input);
  return Math.min(rate.baseRateBps + rate.bonusRateBps, rate.maxRateBps ?? COMMISSION_RULE.limits.basisPoints);
}
export function formatRateBps(value: number): string {
  bps.parse(value);
  const whole = Math.floor(value / COMMISSION_RULE.limits.basisPoints);
  const fraction = String(value % COMMISSION_RULE.limits.basisPoints).padStart(COMMISSION_RULE.limits.decimalPlaces, COMMISSION_RULE.zeroDigit);
  return `${whole}${COMMISSION_RULE.decimalSeparator}${fraction}`;
}
export function parseStoredRate(value: string): number {
  if (!COMMISSION_RULE.ratePattern.test(value)) throw new Error(COMMISSION_RULE.failure.persisted);
  const [whole, fraction] = value.split(COMMISSION_RULE.decimalSeparator);
  return Number(whole) * COMMISSION_RULE.limits.basisPoints + Number(fraction);
}
export function calculateCommissionAmount(baseAmount: number, rateBps: number): number {
  if (!Number.isSafeInteger(baseAmount) || baseAmount < COMMISSION_RULE.limits.zero) throw new Error(COMMISSION_RULE.failure.amount);
  bps.parse(rateBps);
  const denominator = BigInt(COMMISSION_RULE.limits.basisPoints);
  return Number((BigInt(baseAmount) * BigInt(rateBps) + denominator / BigInt(COMMISSION_RULE.limits.halfDivisor)) / denominator);
}
