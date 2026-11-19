import {z} from 'zod';

export const DEVELOPMENT_LOGIN = {
  environment: 'development',
  alias: 'test',
  ready: 'ready',
  route: 'auth/development-login',
  response: {cacheHeader: 'Cache-Control', cachePolicy: 'no-store'},
  failure: {missing: 'Development login is not available', unavailable: 'Development login configuration is unavailable'}
} as const;

export const developmentLoginRegistrySchema = z.object({
  environment: z.literal(DEVELOPMENT_LOGIN.environment),
  alias: z.literal(DEVELOPMENT_LOGIN.alias),
  status: z.literal(DEVELOPMENT_LOGIN.ready),
  email: z.email(),
  supabaseURL: z.url()
});

export type DevelopmentLoginResolution = {alias: string; email: string; supabaseURL: string};
