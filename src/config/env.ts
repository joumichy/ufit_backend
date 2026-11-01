import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

const booleanFromEnv = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((value) => {
    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value !== 'string' || value.length === 0) {
      return undefined;
    }

    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true;
    }

    if (['0', 'false', 'no', 'off'].includes(normalized)) {
      return false;
    }

    throw new Error(`Invalid boolean env value: ${value}`);
  });

const optionalNonEmptyString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim().length === 0 ? undefined : value),
  z.string().min(1).optional()
);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().max(65535).default(4000),
  API_ORIGIN: z.string().url().optional(),
  MEDIA_PUBLIC_API_ORIGIN: z.string().url().optional(),
  WEB_ORIGIN: z.string().url().optional(),
  UFIT_DB_SCHEMA: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'UFIT_DB_SCHEMA must be a valid PostgreSQL identifier')
    .default('ufit'),
  SUPABASE_URL: z.string().url(),
  SUPABASE_PUBLIC_KEY: optionalNonEmptyString,
  SUPABASE_SECRET_KEY: optionalNonEmptyString,
  SUPABASE_JWT_SECRET: optionalNonEmptyString,
  SUPABASE_DIRECT_CONNECTION_DB_URL: z.string().min(1),
  SUPABASE_DB_SSL: booleanFromEnv.default(true),
  SUPABASE_DB_TLS_REJECT_UNAUTHORIZED: booleanFromEnv.default(false),
  SUPABASE_DB_CA_CERT: optionalNonEmptyString,
  STRIPE_SECRET_KEY: optionalNonEmptyString,
  STRIPE_WEBHOOK_SECRET: optionalNonEmptyString,
  STRIPE_CHECKOUT_SUCCESS_URL: optionalNonEmptyString,
  STRIPE_CHECKOUT_CANCEL_URL: optionalNonEmptyString
});

export type AppEnv = z.infer<typeof envSchema>;

let cachedEnv: AppEnv | undefined;

export function loadEnvFiles(baseDir = process.cwd()): void {
  const candidates = [
    resolve(baseDir, '.env'),
    resolve(baseDir, '.env.local'),
    resolve(baseDir, '..', '.env'),
    resolve(baseDir, '..', '.env.local')
  ];

  for (const path of candidates) {
    if (existsSync(path)) {
      dotenv.config({ path });
    }
  }
}

export function parseEnv(rawEnv: NodeJS.ProcessEnv): AppEnv {
  const parsed = envSchema.safeParse(rawEnv);
  if (parsed.success) {
    return parsed.data;
  }

  const details = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
    .join('; ');

  throw new Error(`Invalid UFit backend environment: ${details}`);
}

export function getEnv(): AppEnv {
  if (!cachedEnv) {
    loadEnvFiles();
    cachedEnv = parseEnv(process.env);
  }

  return cachedEnv;
}

export function resetEnvCacheForTests(): void {
  cachedEnv = undefined;
}
