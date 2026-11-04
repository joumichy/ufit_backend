import {PUSH_DELIVERY} from '../modules/notifications/domain/push-delivery';
import {EMAIL_DELIVERY} from '../modules/notifications/domain/email-delivery';
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
  API_HOST: z.union([z.ipv4(), z.ipv6()]).optional(),
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
  NOTIFICATION_PUSH_ENABLED: booleanFromEnv.default(false),
  APNS_ENVIRONMENT: z.enum(Object.values(PUSH_DELIVERY.environment)).optional(),
  APNS_KEY_ID: optionalNonEmptyString,
  APNS_TEAM_ID: optionalNonEmptyString,
  APNS_PRIVATE_KEY: optionalNonEmptyString,
  APNS_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  NOTIFICATION_EMAIL_ENABLED: booleanFromEnv.default(false),
  RESEND_API_KEY: optionalNonEmptyString,
  RESEND_BASE_URL: z.string().url().optional(),
  RESEND_SEND_PATH: optionalNonEmptyString,
  RESEND_FROM_NAME: optionalNonEmptyString,
  RESEND_FROM_ADDRESS: optionalNonEmptyString.pipe(z.email().optional()),
  RESEND_TIMEOUT_MS: z.coerce.number().int().positive().max(EMAIL_DELIVERY.limits.maximumTimeoutMs).default(EMAIL_DELIVERY.limits.defaultTimeoutMs),
  STRIPE_SECRET_KEY: optionalNonEmptyString,
  STRIPE_WEBHOOK_SECRET: optionalNonEmptyString,
  STRIPE_CHECKOUT_SUCCESS_URL: optionalNonEmptyString,
  STRIPE_CHECKOUT_CANCEL_URL: optionalNonEmptyString
});

export type AppEnv = z.infer<typeof envSchema>;

let cachedEnv: AppEnv | undefined;

const ENV_PROFILE = {primary: '.env', local: '.env.local', parent: '..'} as const;

export function loadEnvFile(baseDir = process.cwd()): string | undefined {
  const candidates = [
    resolve(baseDir, ENV_PROFILE.primary),
    resolve(baseDir, ENV_PROFILE.local),
    resolve(baseDir, ENV_PROFILE.parent, ENV_PROFILE.primary),
    resolve(baseDir, ENV_PROFILE.parent, ENV_PROFILE.local)
  ];
  const selected = candidates.find(path => existsSync(path));
  if (selected) {
    const result = dotenv.config({path: selected});
    if (result.error) throw result.error;
  }
  return selected;
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
    loadEnvFile();
    cachedEnv = parseEnv(process.env);
  }

  return cachedEnv;
}

export function resetEnvCacheForTests(): void {
  cachedEnv = undefined;
}
