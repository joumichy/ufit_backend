import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';
import { loadEnvFiles, parseEnv } from './src/config/env';

loadEnvFiles();
const env = parseEnv(process.env);

export default defineConfig({
  schema: './src/shared/infrastructure/database/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: env.SUPABASE_DIRECT_CONNECTION_DB_URL,
    ssl: env.SUPABASE_DB_SSL
  },
  schemaFilter: [env.UFIT_DB_SCHEMA],
  verbose: true,
  strict: true
});
