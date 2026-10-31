export const GENDER_TARGETS = ['male', 'female', 'unisex'] as const;
export type GenderTarget = (typeof GENDER_TARGETS)[number];
