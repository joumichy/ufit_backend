import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {loadEnvFile, parseEnv} from '../src/config/env';

const PROFILE = {primary: '.env', local: '.env.local'} as const;
const FIXTURE = {
  prefix: 'ufit-env-profile-',
  backend: 'backend',
  port: '4101',
  inheritedPort: '4102',
  overriddenPort: '4103',
  supabaseURL: 'https://example.supabase.co',
  databaseURL: 'postgres://fixture@localhost:5432/postgres',
  newline: '\n',
  missingFields: /SUPABASE_URL|SUPABASE_DIRECT_CONNECTION_DB_URL/
} as const;
const KEY = {port: 'API_PORT', supabaseURL: 'SUPABASE_URL', databaseURL: 'SUPABASE_DIRECT_CONNECTION_DB_URL'} as const;
const serialize = (values: Record<string, string>) => Object.entries(values)
  .map(([key, value]) => `${key}=${value}`).join(FIXTURE.newline);
const requiredValues = {[KEY.supabaseURL]: FIXTURE.supabaseURL, [KEY.databaseURL]: FIXTURE.databaseURL};

describe('Single environment profile', () => {
  let workspace: string;
  let backend: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), FIXTURE.prefix));
    backend = join(workspace, FIXTURE.backend);
    mkdirSync(backend);
    for (const key of Object.values(KEY)) vi.stubEnv(key, undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(workspace, {recursive: true, force: true});
  });

  it('does not complete the selected app profile with fields from another profile', () => {
    const selected = join(backend, PROFILE.primary);
    writeFileSync(selected, serialize({[KEY.port]: FIXTURE.port}));
    writeFileSync(join(backend, PROFILE.local), serialize({[KEY.port]: FIXTURE.inheritedPort, ...requiredValues}));
    writeFileSync(join(workspace, PROFILE.primary), serialize(requiredValues));
    writeFileSync(join(workspace, PROFILE.local), serialize(requiredValues));

    expect(loadEnvFile(backend)).toBe(selected);
    expect(process.env[KEY.port]).toBe(FIXTURE.port);
    expect(process.env[KEY.supabaseURL]).toBeUndefined();
    expect(process.env[KEY.databaseURL]).toBeUndefined();
    expect(() => parseEnv(process.env)).toThrow(FIXTURE.missingFields);
  });

  it('selects the app local profile before a parent profile without combining them', () => {
    const selected = join(backend, PROFILE.local);
    writeFileSync(selected, serialize(requiredValues));
    writeFileSync(join(workspace, PROFILE.primary), serialize({[KEY.port]: FIXTURE.inheritedPort}));

    expect(loadEnvFile(backend)).toBe(selected);
    expect(parseEnv(process.env).SUPABASE_URL).toBe(FIXTURE.supabaseURL);
    expect(process.env[KEY.port]).toBeUndefined();
  });

  it('uses the parent primary profile alone when the app has no profile', () => {
    const selected = join(workspace, PROFILE.primary);
    writeFileSync(selected, serialize(requiredValues));
    writeFileSync(join(workspace, PROFILE.local), serialize({[KEY.port]: FIXTURE.inheritedPort}));

    expect(loadEnvFile(backend)).toBe(selected);
    expect(parseEnv(process.env).SUPABASE_DIRECT_CONNECTION_DB_URL).toBe(FIXTURE.databaseURL);
    expect(process.env[KEY.port]).toBeUndefined();
  });

  it('can select the parent local profile when it is the only profile present', () => {
    const selected = join(workspace, PROFILE.local);
    writeFileSync(selected, serialize(requiredValues));

    expect(loadEnvFile(backend)).toBe(selected);
    expect(parseEnv(process.env).SUPABASE_URL).toBe(FIXTURE.supabaseURL);
  });

  it('preserves explicit process configuration over the single selected file', () => {
    vi.stubEnv(KEY.port, FIXTURE.overriddenPort);
    writeFileSync(join(backend, PROFILE.primary), serialize({[KEY.port]: FIXTURE.port, ...requiredValues}));

    loadEnvFile(backend);
    expect(process.env[KEY.port]).toBe(FIXTURE.overriddenPort);
  });

  it('does not search another profile after the selected path fails to load', () => {
    mkdirSync(join(backend, PROFILE.primary));
    writeFileSync(join(workspace, PROFILE.primary), serialize(requiredValues));

    expect(() => loadEnvFile(backend)).toThrow();
    expect(process.env[KEY.supabaseURL]).toBeUndefined();
    expect(process.env[KEY.databaseURL]).toBeUndefined();
  });

  it('allows an environment supplied entirely by the launching process', () => {
    for (const [key, value] of Object.entries(requiredValues)) vi.stubEnv(key, value);

    expect(loadEnvFile(backend)).toBeUndefined();
    expect(parseEnv(process.env).SUPABASE_URL).toBe(FIXTURE.supabaseURL);
  });
});
