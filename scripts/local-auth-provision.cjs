/** Provision only the explicitly new local Auth database, never an existing hosted profile. */
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {Pool} = require('pg');
const {LOCAL, ensureDependencies} = require('./local-auth-runtime.cjs');
const SOURCE = {
  registry: path.join(os.homedir(), '.codex/private/ufit/mailpit-sandbox.credentials.json'),
  database: 'ufit_mailpit', user: 'ufit_mailpit', marker: 'ufit-mailpit-isolated-v1',
  privateMode: 0o600, secretBytes: 36, jwtBytes: 48,
};
async function provision() {
  await ensureDependencies();
  const source = JSON.parse(await fs.readFile(SOURCE.registry, 'utf8'));
  assert.equal(source.database_name, SOURCE.database); assert.equal(source.database_user, SOURCE.user);
  const pool = new Pool({host: LOCAL.host, port: LOCAL.databasePort, database: source.database_name, user: source.database_user, password: source.database_password, max: 1});
  try {
    const marker = await pool.query('select current_database() as database,marker from ufit_mailpit_sandbox.identity');
    assert.deepEqual(marker.rows, [{database: SOURCE.database, marker: SOURCE.marker}]);
    const existing = await pool.query('select datname from pg_database where datname=$1', [LOCAL.database]);
    let owner;
    try { owner = JSON.parse(await fs.readFile(LOCAL.registry, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      assert.equal(existing.rowCount, 0, 'Existing local Auth persistence has no registry: recover its owner instead of replacing it');
      owner = {marker: LOCAL.marker, database_name: LOCAL.database, database_user: LOCAL.user,
        database_password: crypto.randomBytes(SOURCE.secretBytes).toString('base64url'),
        jwt_secret: crypto.randomBytes(SOURCE.jwtBytes).toString('base64url'), accounts: {}, created_at: new Date().toISOString()};
      await fs.writeFile(LOCAL.registry, JSON.stringify(owner, null, 2), {mode: SOURCE.privateMode, flag: 'wx'});
    }
    assert.equal(owner.marker, LOCAL.marker); assert.equal(owner.database_name, LOCAL.database); assert.equal(owner.database_user, LOCAL.user);
    if (!existing.rowCount) {
      const role = await pool.query('select rolname from pg_roles where rolname=$1', [LOCAL.user]);
      assert.equal(role.rowCount, 0, 'Existing Auth role without database requires recovery');
      const createRole = await pool.query("select format('create role %I login password %L',$1::text,$2::text) command", [LOCAL.user, owner.database_password]);
      await pool.query(createRole.rows[0].command);
      await pool.query('create database "ufit_auth_local" owner "ufit_auth_local"');
    }
    // Official GoTrue migrations grant Auth read access to this conventional role.
    // The standalone PostgreSQL image used by this sandbox has no postgres role.
    const postgres = await pool.query("select rolname from pg_roles where rolname='postgres'");
    if (!postgres.rowCount) await pool.query('create role postgres nologin nosuperuser nocreatedb nocreaterole noinherit');
    const target = new Pool({host: LOCAL.host, port: LOCAL.databasePort, database: owner.database_name, user: owner.database_user, password: owner.database_password, max: 1});
    try {
      await target.query('create schema if not exists ufit_local_auth_sandbox');
      await target.query('create table if not exists ufit_local_auth_sandbox.identity(marker text primary key)');
      const identity = await target.query('select marker from ufit_local_auth_sandbox.identity');
      if (identity.rowCount) assert.deepEqual(identity.rows, [{marker: LOCAL.marker}]);
      else await target.query('insert into ufit_local_auth_sandbox.identity(marker) values($1)', [LOCAL.marker]);
      await target.query('create schema if not exists auth');
      await target.query('alter role "ufit_auth_local" in database "ufit_auth_local" set search_path=auth,extensions,public');
      await target.query('create schema if not exists extensions');
      await target.query('create extension if not exists pgcrypto with schema extensions');
      const extension = await target.query("select n.nspname from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pgcrypto'");
      if (extension.rows[0].nspname !== 'extensions') {
        const ownerConnection = new Pool({host: LOCAL.host, port: LOCAL.databasePort, database: owner.database_name,
          user: source.database_user, password: source.database_password, max: 1});
        try { await ownerConnection.query('alter extension pgcrypto set schema extensions'); }
        finally { await ownerConnection.end(); }
      }
    } finally { await target.end(); }
    console.log(JSON.stringify({database: LOCAL.database, created: !existing.rowCount, existingMailpitDatabasePreserved: true, registry: 'private owner only'}));
  } finally { await pool.end(); }
}
provision().catch(error => { console.error(error instanceof Error ? error.message : 'Local provisioning failed'); process.exitCode = 1; });
