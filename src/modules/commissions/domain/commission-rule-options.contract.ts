import {z} from 'zod';
import {COMMISSION_RULE} from './commission-rule.contract';

export const COMMISSION_OPTIONS = {
  kind: {brands: 'brands', products: 'products', grades: 'grades'},
  limits: {search: 100, cursor: 160},
  wildcard: '%', literalPattern: /[\\%_]/g, escapedLiteral: '\\$&',
  failure: 'La sélection de marque, d’article ou de grade est invalide.',
} as const;
export const commissionOptionKindSchema = z.enum(COMMISSION_OPTIONS.kind);
export type CommissionOptionKind = z.infer<typeof commissionOptionKindSchema>;
export const commissionOptionQuerySchema = z.object({
  brandId: z.uuid().optional(), search: z.string().trim().max(COMMISSION_OPTIONS.limits.search).optional(),
  cursor: z.string().min(COMMISSION_RULE.limits.singleRow).max(COMMISSION_OPTIONS.limits.cursor).optional(),
  limit: z.coerce.number().int().min(COMMISSION_RULE.limits.singleRow).max(COMMISSION_RULE.limits.maximumPage).default(COMMISSION_RULE.limits.page),
}).strict();
export type CommissionOptionQuery = z.infer<typeof commissionOptionQuerySchema>;
export interface CommissionBrandOption {id: string; brandName: string; status: string;}
export interface CommissionProductOption {id: string; brandId: string; name: string; status: string;}
export interface CommissionGradeOption {code: string; label: string; rank: number;}
export type CommissionOptionPage = {nextCursor: string | null} & (
  {kind: typeof COMMISSION_OPTIONS.kind.brands; items: CommissionBrandOption[]} |
  {kind: typeof COMMISSION_OPTIONS.kind.products; items: CommissionProductOption[]} |
  {kind: typeof COMMISSION_OPTIONS.kind.grades; items: CommissionGradeOption[]});

export function parseCommissionOptions(kind: unknown, input: unknown): {kind: CommissionOptionKind; query: CommissionOptionQuery} {
  const parsedKind = commissionOptionKindSchema.parse(kind), query = commissionOptionQuerySchema.parse(input);
  if ((parsedKind === COMMISSION_OPTIONS.kind.products) !== Boolean(query.brandId)) throw new Error(COMMISSION_OPTIONS.failure);
  if (query.cursor && parsedKind !== COMMISSION_OPTIONS.kind.grades && !z.uuid().safeParse(query.cursor).success) throw new Error(COMMISSION_OPTIONS.failure);
  return {kind: parsedKind, query};
}
