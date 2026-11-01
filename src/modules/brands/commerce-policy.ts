import { z } from "zod";
import {COUNTRY_CODES} from '../../shared/domain/countries';
import {CURRENCY_CODES} from '../../shared/domain/currencies';
export const COMMERCE_POLICY_KEY = "commercePolicy";
export const BRAND_COMMERCE = {
  revision: {unconfigured: 0, initial: 1, step: 1, maximum: 2147483647},
  limits: {basisPoints: 10000, safeAmount: 2147483647},
  roles: ['brand_owner', 'brand_manager', 'admin', 'super_admin'],
  persistence: {lock: 'update', versionColumn: 'commerce_policy_version', versionConstraint: 'brand_commerce_policy_version_valid'},
  routes: {brands: 'brands', metadata: 'commerce-policy/metadata', policy: ':id/commerce-policy'},
  failure: {
    input: {code: 'brand_policy_invalid', message: 'Invalid brand commerce policy'},
    persisted: {code: 'brand_policy_invalid', message: 'The brand commerce policy requires correction'},
    access: {code: 'brand_policy_access_required', message: 'An active member or administrator of a non-suspended brand is required'},
    changed: {code: 'brand_policy_version_changed', message: 'The commerce policy changed; reload before editing'},
  },
} as const;
const POLICY_LIMIT = BRAND_COMMERCE.limits;
export const shippingCountrySchema = z.string().refine(code => COUNTRY_CODES.includes(code));
export const brandCommercePolicySchema = z
  .object({
    returnWindowDays: z.number().int().nonnegative(),
    returnPolicy: z.string().trim().min(1),
    pricesIncludeTaxes: z.boolean(),
    taxNotice: z.string().trim().min(1),
    customsNotice: z.string().trim().min(1),
    shippingRates: z
      .array(
        z
          .object({
            country: shippingCountrySchema,
            currency: z.string().refine(code => CURRENCY_CODES.includes(code)),
            amount: z.number().int().nonnegative().max(POLICY_LIMIT.safeAmount),
            taxBasisPoints: z
              .number()
              .int()
              .min(0)
              .max(POLICY_LIMIT.basisPoints),
            taxOnShipping: z.boolean(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((policy, context) => {
    const keys = new Set<string>();
    policy.shippingRates.forEach((rate, index) => {
      const key = rate.country + rate.currency;
      if (keys.has(key))
        context.addIssue({
          code: "custom",
          path: ["shippingRates", index],
          message: "Duplicate country and currency",
        });
      keys.add(key);
    });
  });
export type BrandCommercePolicy = z.infer<typeof brandCommercePolicySchema>;
export const updateBrandCommercePolicySchema = z.object({
  expectedVersion: z.number().int().min(BRAND_COMMERCE.revision.unconfigured).max(BRAND_COMMERCE.revision.maximum - BRAND_COMMERCE.revision.step),
  policy: brandCommercePolicySchema,
}).strict();
export interface BrandCommercePolicyDocument {brandId: string; version: number; policy: BrandCommercePolicy | null;}
