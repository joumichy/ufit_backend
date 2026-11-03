/** Isolated local Supabase Auth qualification; never loads a hosted profile. */
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {spawn, execFile} = require('node:child_process');
const {promisify} = require('node:util');
const execute = promisify(execFile);
const ROOT = path.resolve(__dirname, '..');
const LOCAL = {
  registry: path.join(os.homedir(), '.codex/private/ufit/auth-local.credentials.json'),
  runtime: path.join(os.homedir(), '.codex/private/ufit/auth-local-runtime'),
  marker: 'ufit-local-auth-isolated-v1', database: 'ufit_auth_local', user: 'ufit_auth_local',
  host: '127.0.0.1', databasePort: 15433, authPort: 4035, gatewayPort: 4036, apiPort: 4044,
  authContainer: 'ufit-local-supabase-auth', image: 'supabase/gotrue:v2.197.0',
  imageDigest: 'sha256:1736a63078f5922b198c4cbe50f80ab9a2d3b54fe8b7b6cfb2e9dc5dbbc12c6b',
  dockerHost: 'host.docker.internal', authInternalPort: 9999, smtpPort: 11025,
  prefix: '/auth/v1', apiOrigin: 'http://127.0.0.1:4044', authOrigin: 'http://127.0.0.1:4036',
  site: 'http://127.0.0.1:4036/local-auth', confirmation: 'ufit://auth/callback', recovery: 'ufit://auth/recovery',
  sender: 'no-reply@ufit.invalid', senderName: 'Ufit Local', label: 'com.stellark.ufit.local-auth',
  commands: {start: 'start', gateway: 'gateway', status: 'status'}, mode: 0o600,
  readinessAttempts: 40, readinessDelayMs: 500, requestTimeoutMs: 2000,
  dependencies: [
    {name: 'ufit-mailpit-dev-db', volume: 'ufit-mailpit-dev-db-data'},
    {name: 'ufit-dev-mailpit', volume: 'ufit-dev-mailpit-data'},
  ],
  inheritedProfiles: ['.env', '.env.local', '../.env', '../.env.local'],
  jwt: {algorithm: 'HS256', type: 'JWT', issuer: 'supabase-local', lifetimeSeconds: 315360000,
    millisecondsPerSecond: 1000, anonymousRole: 'anon', serviceRole: 'service_role'},
};
const jwt = (role, secret) => {
  const now = Math.floor(Date.now() / LOCAL.jwt.millisecondsPerSecond);
  const header = Buffer.from(JSON.stringify({alg: LOCAL.jwt.algorithm, typ: LOCAL.jwt.type})).toString('base64url');
  const payload = Buffer.from(JSON.stringify({role, iss: LOCAL.jwt.issuer, iat: now, exp: now + LOCAL.jwt.lifetimeSeconds})).toString('base64url');
  const value = header + '.' + payload;
  return value + '.' + crypto.createHmac('sha256', secret).update(value).digest('base64url');
};
async function registry() {
  const value = JSON.parse(await fs.readFile(LOCAL.registry, 'utf8'));
  assert.equal(value.marker, LOCAL.marker); assert.equal(value.database_name, LOCAL.database); assert.equal(value.database_user, LOCAL.user);
  assert(value.database_password && value.jwt_secret);
  return value;
}
function databaseURL(value, host = LOCAL.host, port = LOCAL.databasePort) {
  const url = new URL('postgresql://' + host + ':' + port + '/' + LOCAL.database);
  url.username = value.database_user; url.password = value.database_password;
  url.searchParams.set('sslmode', 'disable'); return url.href;
}
async function assertDatabase(value) {
  const {Pool} = require('pg');
  const pool = new Pool({connectionString: databaseURL(value), ssl: false, max: 1});
  try {
    const result = await pool.query('select current_database() as database,marker from ufit_local_auth_sandbox.identity');
    assert.deepEqual(result.rows, [{database: LOCAL.database, marker: LOCAL.marker}]);
  } finally { await pool.end(); }
}
async function ensureDependencies() {
  for (const expected of LOCAL.dependencies) {
    const container = JSON.parse((await execute('docker', ['inspect', expected.name])).stdout)[0];
    assert(container.Mounts.some(mount => mount.Name === expected.volume), 'Existing local persistence differs: ' + expected.name);
    if (expected.name === 'ufit-dev-mailpit') {
      assert(!container.Config.Env.some(value => /^MP_SMTP_(RELAY|FORWARD)/.test(value) && value.split('=').slice(1).join('=')), 'Mailpit must not relay local Auth e-mails externally');
      assert(!container.Config.Cmd.some(value => /smtp.*(relay|forward)/.test(value)), 'Mailpit forwarding arguments are not allowed for this local profile');
    }
    if (!container.State.Running) await execute('docker', ['start', expected.name]);
  }
}
async function profile(value) {
  const backend = {
    NODE_ENV: 'development', API_HOST: LOCAL.host, API_PORT: String(LOCAL.apiPort), API_ORIGIN: LOCAL.apiOrigin,
    MEDIA_PUBLIC_API_ORIGIN: LOCAL.apiOrigin, WEB_ORIGIN: LOCAL.authOrigin, UFIT_DB_SCHEMA: 'ufit',
    SUPABASE_URL: LOCAL.authOrigin, SUPABASE_PUBLIC_KEY: jwt(LOCAL.jwt.anonymousRole, value.jwt_secret),
    SUPABASE_SECRET_KEY: jwt(LOCAL.jwt.serviceRole, value.jwt_secret), SUPABASE_JWT_SECRET: value.jwt_secret,
    SUPABASE_DIRECT_CONNECTION_DB_URL: databaseURL(value), SUPABASE_DB_SSL: 'false',
    NOTIFICATION_PUSH_ENABLED: 'false', NOTIFICATION_EMAIL_ENABLED: 'false',
  };
  const auth = {
    GOTRUE_API_HOST: '0.0.0.0', GOTRUE_API_PORT: String(LOCAL.authInternalPort), API_EXTERNAL_URL: LOCAL.authOrigin + LOCAL.prefix,
    GOTRUE_DB_DRIVER: 'postgres', GOTRUE_DB_DATABASE_URL: databaseURL(value, LOCAL.dockerHost), DB_NAMESPACE: 'auth',
    GOTRUE_SITE_URL: LOCAL.site, GOTRUE_URI_ALLOW_LIST: [LOCAL.confirmation, LOCAL.recovery].join(','),
    GOTRUE_DISABLE_SIGNUP: 'false', GOTRUE_EXTERNAL_EMAIL_ENABLED: 'true', GOTRUE_EXTERNAL_PHONE_ENABLED: 'false',
    GOTRUE_EXTERNAL_APPLE_ENABLED: 'false', GOTRUE_JWT_SECRET: value.jwt_secret,
    GOTRUE_JWT_ISSUER: LOCAL.authOrigin + LOCAL.prefix, GOTRUE_JWT_AUD: 'authenticated',
    GOTRUE_JWT_DEFAULT_GROUP_NAME: 'authenticated', GOTRUE_JWT_ADMIN_ROLES: 'service_role', GOTRUE_JWT_EXP: '3600',
    GOTRUE_MAILER_AUTOCONFIRM: 'false', GOTRUE_SMTP_HOST: LOCAL.dockerHost, GOTRUE_SMTP_PORT: String(LOCAL.smtpPort),
    GOTRUE_SMTP_ADMIN_EMAIL: LOCAL.sender, GOTRUE_SMTP_SENDER_NAME: LOCAL.senderName, GOTRUE_SMTP_MAX_FREQUENCY: '1s',
    GOTRUE_MAILER_URLPATHS_CONFIRMATION: LOCAL.prefix + '/verify', GOTRUE_MAILER_URLPATHS_RECOVERY: LOCAL.prefix + '/verify',
    GOTRUE_RATE_LIMIT_EMAIL_SENT: '100', GOTRUE_MAILER_SUBJECTS_CONFIRMATION: 'Confirmez votre compte Ufit local',
    GOTRUE_MAILER_SUBJECTS_RECOVERY: 'Réinitialisez votre mot de passe Ufit local',
  };
  await fs.mkdir(LOCAL.runtime, {recursive: true, mode: 0o700});
  for (const name of LOCAL.inheritedProfiles) {
    try { await fs.access(path.resolve(LOCAL.runtime, name)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw Error('An environment file would mix profiles in the isolated runtime: ' + name);
  }
  await fs.writeFile(path.join(LOCAL.runtime, 'backend.env.json'), JSON.stringify(backend, null, 2), {mode: LOCAL.mode});
  await fs.writeFile(path.join(LOCAL.runtime, 'gotrue.env'), Object.entries(auth).map(([name, val]) => name + '=' + val).join('\n') + '\n', {mode: LOCAL.mode});
  await fs.writeFile(path.join(LOCAL.runtime, 'ios.env.json'), JSON.stringify({UFIT_API_BASE_URL: LOCAL.apiOrigin, SUPABASE_URL: LOCAL.authOrigin, SUPABASE_PUBLIC_KEY: backend.SUPABASE_PUBLIC_KEY}, null, 2), {mode: LOCAL.mode});
  return {backend, auth};
}
function selectedEnvironment(values) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG']) if (process.env[key]) env[key] = process.env[key];
  return {...env, ...values, NODE_PATH: path.join(ROOT, 'node_modules')};
}
async function ready(url) {
  for (let attempt = 0; attempt < LOCAL.readinessAttempts; attempt++) {
    try { const response = await fetch(url, {signal: AbortSignal.timeout(LOCAL.requestTimeoutMs)}); if (response.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, LOCAL.readinessDelayMs));
  }
  throw Error('Local service did not become healthy: ' + url);
}
async function daemon(name, args, values) {
  const pidPath = path.join(LOCAL.runtime, name + '.pid.json');
  try {
    const state = JSON.parse(await fs.readFile(pidPath, 'utf8'));
    process.kill(state.pid, 0); return state.pid;
  } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  const log = await fs.open(path.join(LOCAL.runtime, name + '.private.log'), 'a', LOCAL.mode);
  try {
    const child = spawn(process.execPath, args, {cwd: LOCAL.runtime, env: selectedEnvironment(values), detached: true, stdio: ['ignore', log.fd, log.fd]});
    child.unref(); await fs.writeFile(pidPath, JSON.stringify({pid: child.pid, createdAt: new Date().toISOString()}), {mode: LOCAL.mode});
    return child.pid;
  } finally { await log.close(); }
}
async function gateway() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, LOCAL.authOrigin);
    if (!url.pathname.startsWith(LOCAL.prefix + '/')) {
      response.writeHead(404, {'content-type': 'text/plain'}); response.end('Ufit local Auth only'); return;
    }
    const target = url.pathname.slice(LOCAL.prefix.length) + url.search;
    const upstream = http.request({host: LOCAL.host, port: LOCAL.authPort, path: target, method: request.method, headers: {...request.headers, host: LOCAL.host + ':' + LOCAL.authPort}}, result => {
      response.writeHead(result.statusCode, result.headers); result.pipe(response);
    });
    upstream.on('error', () => { response.writeHead(502); response.end(); }); request.pipe(upstream);
  });
  server.listen(LOCAL.gatewayPort, LOCAL.host);
  process.once('SIGTERM', () => server.close());
}
async function start() {
  await ensureDependencies();
  const value = await registry(); await assertDatabase(value); const configuration = await profile(value);
  let image;
  try { image = JSON.parse((await execute('docker', ['image', 'inspect', LOCAL.image])).stdout)[0]; }
  catch (error) {
    if (!String(error.stderr).toLowerCase().includes('no such image')) throw error;
    await execute('docker', ['pull', LOCAL.image]);
    image = JSON.parse((await execute('docker', ['image', 'inspect', LOCAL.image])).stdout)[0];
  }
  assert(image.RepoDigests.some(digest => digest.endsWith('@' + LOCAL.imageDigest)), 'Unexpected GoTrue image digest');
  let container;
  try { container = JSON.parse((await execute('docker', ['inspect', LOCAL.authContainer])).stdout)[0]; }
  catch (error) { if (!String(error.stderr).toLowerCase().includes('no such object')) throw error; }
  if (container) {
    assert.equal(container.Config.Labels[LOCAL.label], LOCAL.marker);
    for (const [key, val] of Object.entries(configuration.auth)) assert(container.Config.Env.includes(key + '=' + val), 'Existing Auth configuration differs: ' + key);
    if (!container.State.Running) await execute('docker', ['start', LOCAL.authContainer]);
  } else {
    await execute('docker', ['run', '-d', '--name', LOCAL.authContainer, '--label', LOCAL.label + '=' + LOCAL.marker,
      '--restart', 'unless-stopped', '--env-file', path.join(LOCAL.runtime, 'gotrue.env'),
      '-p', LOCAL.host + ':' + LOCAL.authPort + ':' + LOCAL.authInternalPort, LOCAL.image]);
  }
  await ready('http://' + LOCAL.host + ':' + LOCAL.authPort + '/health');
  const gatewayPID = await daemon('gateway', [__filename, LOCAL.commands.gateway], {});
  await ready(LOCAL.authOrigin + LOCAL.prefix + '/health');
  const migrationCLI = require.resolve('tsx/cli');
  const migration = await execute(process.execPath, [migrationCLI, path.join(ROOT, 'src/shared/infrastructure/database/migrate.ts')], {cwd: LOCAL.runtime, env: selectedEnvironment(configuration.backend)});
  await fs.writeFile(path.join(LOCAL.runtime, 'migrations.log'), migration.stdout, {mode: LOCAL.mode});
  const buildPath = path.join(LOCAL.runtime, 'backend');
  await execute(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', path.join(ROOT, 'tsconfig.build.json'), '--outDir', buildPath, '--tsBuildInfoFile', path.join(LOCAL.runtime, 'backend.tsbuildinfo')], {cwd: ROOT, env: selectedEnvironment(configuration.backend), maxBuffer: 1024 * 1024});
  const backendPID = await daemon('backend', [path.join(buildPath, 'src/main.js')], configuration.backend);
  await ready(LOCAL.apiOrigin + '/health');
  console.log(JSON.stringify({auth: LOCAL.authOrigin, backend: LOCAL.apiOrigin, database: LOCAL.database, smtp: 'Mailpit Ufit loopback only', gatewayPID, backendPID, hostedProfileLoaded: false}));
}
async function main() {
  const command = process.argv[2] ?? LOCAL.commands.start;
  if (command === LOCAL.commands.gateway) { await gateway(); return; }
  if (command === LOCAL.commands.start) { await start(); return; }
  if (command === LOCAL.commands.status) {
    const value = await registry(); await assertDatabase(value); await ready(LOCAL.authOrigin + LOCAL.prefix + '/health'); await ready(LOCAL.apiOrigin + '/health');
    console.log(JSON.stringify({local: true, database: LOCAL.database, auth: LOCAL.authOrigin, backend: LOCAL.apiOrigin, healthy: true})); return;
  }
  throw Error('Use start or status');
}
if (require.main === module) main().catch(error => { console.error(error instanceof Error ? error.message : 'Local Auth failed'); process.exitCode = 1; });
module.exports = {LOCAL, registry, selectedEnvironment, databaseURL, ensureDependencies};
