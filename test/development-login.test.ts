import 'reflect-metadata';
import {Test} from '@nestjs/testing';
import type {INestApplication} from '@nestjs/common';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import request from 'supertest';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {parseEnv, type AppEnv} from '../src/config/env';
import {DevelopmentLoginService} from '../src/modules/identity/application/development-login.service';
import {DevelopmentLoginController} from '../src/modules/identity/presentation/controllers/development-login.controller';
import {DEVELOPMENT_LOGIN as D} from '../src/modules/identity/domain/development-login.contract';

const fixture = {
  prefix: 'ufit-development-login-', file: 'registry.json', encoding: 'utf8',
  url: 'https://example.supabase.co', otherURL: 'https://other.supabase.co',
  database: 'postgres://fixture:fixture@localhost:5432/postgres',
  email: 'development-fixture@example.invalid', secret: 'must-not-be-returned',
  pending: 'requested', malformed: '{', unknownAlias: 'unknown',
  status: {ok: 200, unavailable: 503, missing: 404},
  environment: {development: 'development', test: 'test', production: 'production'},
  fields: {login: 'UFIT_DEVELOPMENT_LOGIN_REGISTRY', notifications: 'UFIT_DEVELOPMENT_NOTIFICATIONS_CONFIG'},
  cacheHeader: 'cache-control', mode: 0o600,
} as const;
const environment = vi.hoisted(() => ({current: undefined as AppEnv | undefined}));
vi.mock('../src/config/env', async importOriginal => ({
  ...await importOriginal<typeof import('../src/config/env')>(), getEnv: () => environment.current,
}));

describe('Development login resolution', () => {
  let directory: string, registry: string, app: INestApplication;
  const document = () => ({environment: D.environment, alias: D.alias, status: D.ready,
    email: fixture.email, supabaseURL: fixture.url, password: fixture.secret});
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), fixture.prefix)); registry = join(directory, fixture.file);
    environment.current = parseEnv({NODE_ENV: D.environment, SUPABASE_URL: fixture.url,
      SUPABASE_DIRECT_CONNECTION_DB_URL: fixture.database, [fixture.fields.login]: registry});
    const module = await Test.createTestingModule({controllers: [DevelopmentLoginController], providers: [DevelopmentLoginService]}).compile();
    app = module.createNestApplication(); await app.init();
  });
  afterEach(async () => {await app?.close(); await rm(directory, {recursive: true, force: true});});
  const route = (alias: string = D.alias) => `/${D.route}/${alias}`;
  const save = (value: unknown) => writeFile(registry, JSON.stringify(value), {mode: fixture.mode});

  it('resolves only the exact alias without returning credentials or a session', async () => {
    await save(document());
    const response = await request(app.getHttpServer()).get(route()).expect(fixture.status.ok);
    expect(response.body).toEqual({alias: D.alias, email: fixture.email, supabaseURL: fixture.url});
    expect(response.headers[fixture.cacheHeader]).toBe(D.response.cachePolicy);
    await request(app.getHttpServer()).get(route(fixture.unknownAlias)).expect(fixture.status.missing);
  });
  it.each([fixture.environment.test, fixture.environment.production])('is absent in %s even with a registry', async name => {
    await save(document()); environment.current = {...environment.current!, NODE_ENV: name};
    await request(app.getHttpServer()).get(route()).expect(fixture.status.missing);
  });
  it('is absent when no development registry was selected', async () => {
    environment.current = {...environment.current!, UFIT_DEVELOPMENT_LOGIN_REGISTRY: undefined};
    await request(app.getHttpServer()).get(route()).expect(fixture.status.missing);
  });
  it('refuses a different Supabase project instead of selecting another account', async () => {
    await save({...document(), supabaseURL: fixture.otherURL});
    const response = await request(app.getHttpServer()).get(route()).expect(fixture.status.unavailable);
    expect(response.body.message).toBe(D.failure.unavailable);
    expect(JSON.stringify(response.body)).not.toContain(fixture.email);
  });
  it('refuses an incomplete or malformed registry and recovers after correction', async () => {
    await request(app.getHttpServer()).get(route()).expect(fixture.status.unavailable);
    await writeFile(registry, fixture.malformed);
    await request(app.getHttpServer()).get(route()).expect(fixture.status.unavailable);
    await save({...document(), status: fixture.pending});
    await request(app.getHttpServer()).get(route()).expect(fixture.status.unavailable);
    await save(document());
    await request(app.getHttpServer()).get(route()).expect(fixture.status.ok);
  });
});

describe('Private development configuration environment', () => {
  const base = {SUPABASE_URL: fixture.url, SUPABASE_DIRECT_CONNECTION_DB_URL: fixture.database};
  it.each(Object.values(fixture.fields))('rejects %s outside development', field => {
    for (const name of [fixture.environment.test, fixture.environment.production]) {
      expect(() => parseEnv({...base, NODE_ENV: name, [field]: fixture.file})).toThrow(field);
    }
    expect(parseEnv({...base, NODE_ENV: D.environment, [field]: fixture.file})[field]).toBe(fixture.file);
  });
});
