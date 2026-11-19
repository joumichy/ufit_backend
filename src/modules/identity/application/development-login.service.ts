import {Injectable, NotFoundException, ServiceUnavailableException} from '@nestjs/common';
import {readFile} from 'node:fs/promises';
import {getEnv} from '../../../config/env';
import {DEVELOPMENT_LOGIN as D, developmentLoginRegistrySchema, type DevelopmentLoginResolution} from '../domain/development-login.contract';

@Injectable()
export class DevelopmentLoginService {
  async resolve(): Promise<DevelopmentLoginResolution> {
    const env = getEnv();
    if (env.NODE_ENV !== D.environment || !env.UFIT_DEVELOPMENT_LOGIN_REGISTRY) {
      throw new NotFoundException(D.failure.missing);
    }
    try {
      const document = JSON.parse(await readFile(env.UFIT_DEVELOPMENT_LOGIN_REGISTRY, 'utf8'));
      const registry = developmentLoginRegistrySchema.parse(document);
      if (registry.supabaseURL !== env.SUPABASE_URL) throw new Error(D.failure.unavailable);
      return {alias: registry.alias, email: registry.email, supabaseURL: registry.supabaseURL};
    } catch {
      throw new ServiceUnavailableException(D.failure.unavailable);
    }
  }
}
