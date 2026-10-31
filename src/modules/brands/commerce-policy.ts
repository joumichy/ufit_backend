import { z } from "zod";
export const COMMERCE_POLICY_KEY = "commercePolicy";
const POLICY_LIMIT = { basisPoints: 10000, safeAmount: 2147483647 } as const;
const COUNTRY_FORMAT = /^[A-Z]{2}$/;
const CURRENCY_FORMAT = /^[A-Z]{3}$/;
export const shippingCountrySchema = z.string().regex(COUNTRY_FORMAT);
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
            currency: z.string().regex(CURRENCY_FORMAT),
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
