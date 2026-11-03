/** Backend integration qualification against the isolated local Auth + Mailpit plane. No UI automation. */
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {createClient} = require('@supabase/supabase-js');
const {Pool} = require('pg');
const {LOCAL, registry, databaseURL} = require('./local-auth-runtime.cjs');
const Q = {
  mailpit: 'http://127.0.0.1:18025', search: '/api/v1/search', message: '/api/v1/message/',
  domain: '@ufit.invalid', secretBytes: 30, nonceBytes: 5, attempts: 30, delayMs: 250,
  sender: 'no-reply@ufit.invalid', proof: 'http-qualification.json', success: 200,
  credentialsRejected: 'invalid_credentials', syntheticName: 'Compte local HTTP Ufit',
};
function auth(publicKey) {
  const values = new Map();
  return createClient(LOCAL.authOrigin, publicKey, {auth: {persistSession: true, autoRefreshToken: false,
    detectSessionInUrl: false, flowType: 'pkce', storage: {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)}}});
}
async function captured(email, excluded = new Set()) {
  for (let attempt = 0; attempt < Q.attempts; attempt++) {
    const query = new URL(Q.mailpit + Q.search); query.searchParams.set('query', 'to:' + email);
    const listing = await (await fetch(query)).json();
    const message = listing.messages.find(value => !excluded.has(value.ID));
    if (message) {
      const details = await (await fetch(Q.mailpit + Q.message + message.ID)).json();
      assert.equal(details.From.Address, Q.sender); assert(details.To.some(value => value.Address === email));
      const match = details.Text.match(/https?:\/\/[^\s<>]+/);
      assert(match, 'Captured message has no confirmation link');
      const link = new URL(match[0].replaceAll('&amp;', '&'));
      assert.equal(link.origin, LOCAL.authOrigin); assert.equal(link.pathname, LOCAL.prefix + '/verify');
      return {id: message.ID, link};
    }
    await new Promise(resolve => setTimeout(resolve, Q.delayMs));
  }
  throw Error('No real SMTP message captured in local Mailpit');
}
async function exchange(client, link, expectedRedirect) {
  const response = await fetch(link, {redirect: 'manual'});
  assert([302, 303].includes(response.status));
  const callback = new URL(response.headers.get('location'));
  const expected = new URL(expectedRedirect);
  assert.equal(callback.protocol, expected.protocol); assert.equal(callback.host, expected.host); assert.equal(callback.pathname, expected.pathname);
  assert(callback.searchParams.get('code')); assert.equal(callback.searchParams.get('error'), null);
  const result = await client.auth.exchangeCodeForSession(callback.searchParams.get('code'));
  assert.equal(result.error, null); assert(result.data.session);
  return result.data.session;
}
async function me(token) {
  const response = await fetch(LOCAL.apiOrigin + '/me', {headers: {Authorization: 'Bearer ' + token}});
  return {status: response.status, body: await response.json()};
}
async function qualify() {
  const owner = await registry();
  const selected = JSON.parse(await fs.readFile(path.join(LOCAL.runtime, 'backend.env.json'), 'utf8'));
  assert.equal(selected.SUPABASE_URL, LOCAL.authOrigin); assert.equal(selected.API_ORIGIN, LOCAL.apiOrigin);
  const suffix = crypto.randomBytes(Q.nonceBytes).toString('hex');
  const accountKey = 'http_' + suffix;
  const account = {email: accountKey + Q.domain, password: crypto.randomBytes(Q.secretBytes).toString('base64url'),
    passwordAfter: crypto.randomBytes(Q.secretBytes).toString('base64url'), purpose: 'Isolated local Auth HTTP and Mailpit qualification', createdAt: new Date().toISOString()};
  owner.accounts[accountKey] = account;
  await fs.writeFile(LOCAL.registry, JSON.stringify(owner, null, 2), {mode: LOCAL.mode});
  const client = auth(selected.SUPABASE_PUBLIC_KEY);
  const verifier = crypto.randomBytes(Q.secretBytes).toString('base64url');
  const signupURL = new URL(LOCAL.authOrigin + LOCAL.prefix + '/signup'); signupURL.searchParams.set('redirect_to', LOCAL.confirmation);
  const signupResponse = await fetch(signupURL, {method: 'POST', headers: {'content-type': 'application/json', apikey: selected.SUPABASE_PUBLIC_KEY},
    body: JSON.stringify({email: account.email, password: account.password, data: {full_name: Q.syntheticName},
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 's256'})});
  const signUp = await signupResponse.json(); assert.equal(signupResponse.status, Q.success); assert(signUp.id); assert.equal(signUp.email_confirmed_at, undefined);
  account.authSubject = signUp.id;
  const unconfirmed = await auth(selected.SUPABASE_PUBLIC_KEY).auth.signInWithPassword({email: account.email, password: account.password});
  assert.equal(unconfirmed.error?.code, 'email_not_confirmed');
  const confirmation = await captured(account.email);
  const verified = await fetch(confirmation.link, {redirect: 'manual'});
  const callback = new URL(verified.headers.get('location')); assert.equal(callback.origin, new URL(LOCAL.confirmation).origin);
  assert.equal(callback.pathname, new URL(LOCAL.confirmation).pathname); assert(callback.searchParams.get('code'));
  const tokenResponse = await fetch(LOCAL.authOrigin + LOCAL.prefix + '/token?grant_type=pkce', {
    method: 'POST', headers: {'content-type': 'application/json', apikey: selected.SUPABASE_PUBLIC_KEY},
    body: JSON.stringify({auth_code: callback.searchParams.get('code'), code_verifier: verifier})});
  assert.equal(tokenResponse.status, Q.success); const session = await tokenResponse.json(); assert(session.access_token); assert(session.user);
  assert.equal(session.user.id, account.authSubject);
  const identity = await me(session.access_token);
  assert.equal(identity.status, Q.success); assert.equal(identity.body.status, 'active'); assert.deepEqual(identity.body.roles, ['customer']);
  account.userID = identity.body.id;
  const pool = new Pool({connectionString: databaseURL(owner), ssl: false, max: 1});
  try {
    const persisted = await pool.query('select id,supabase_user_id from ufit.users where id=$1', [account.userID]);
    assert.equal(persisted.rowCount, 1); assert.equal(persisted.rows[0].supabase_user_id, account.authSubject);
    const reset = await client.auth.resetPasswordForEmail(account.email, {redirectTo: LOCAL.recovery}); assert.equal(reset.error, null);
    const recovery = await captured(account.email, new Set([confirmation.id]));
    const recoverySession = await exchange(client, recovery.link, LOCAL.recovery);
    assert.equal(recoverySession.user.id, account.authSubject);
    const update = await client.auth.updateUser({password: account.passwordAfter}); assert.equal(update.error, null);
    account.activePassword = 'passwordAfter';
    const oldCredential = await auth(selected.SUPABASE_PUBLIC_KEY).auth.signInWithPassword({email: account.email, password: account.password});
    assert.equal(oldCredential.error?.code, Q.credentialsRejected);
    const freshClient = auth(selected.SUPABASE_PUBLIC_KEY);
    const fresh = await freshClient.auth.signInWithPassword({email: account.email, password: account.passwordAfter}); assert.equal(fresh.error, null);
    const current = await me(fresh.data.session.access_token); assert.equal(current.status, Q.success); assert.equal(current.body.id, account.userID);
    const reuse = await fetch(recovery.link, {redirect: 'manual'}); const reuseLocation = new URL(reuse.headers.get('location'));
    assert.equal(reuseLocation.searchParams.get('code'), null); assert(reuseLocation.hash.includes('error') || reuseLocation.searchParams.has('error'));
    account.state = 'confirmed_recovered_password_changed_http';
    const proof = {createdAt: new Date().toISOString(), plane: {auth: LOCAL.authOrigin, backend: LOCAL.apiOrigin, database: LOCAL.database, mailpit: Q.mailpit},
      signupUnconfirmed: true, unconfirmedLoginRejected: true, smtpMessageIDs: [confirmation.id, recovery.id],
      confirmationPKCE: true, recoveryPKCE: true, passwordChangeHTTP: true, oldPasswordRejected: true,
      newPasswordLogin: true, backendMeActiveCustomer: true, localBusinessIdentityPersisted: true, recoveryLinkReuseRejected: true,
      mailDelivery: 'local SMTP capture only', nativeFrontendVerified: false, hostedConfigOrDataTouched: false};
    await fs.writeFile(path.join(LOCAL.runtime, Q.proof), JSON.stringify(proof, null, 2), {mode: LOCAL.mode});
    await freshClient.auth.signOut({scope: 'local'});
    console.log(JSON.stringify(proof));
  } finally {
    await pool.end();
    const latest = await registry(); latest.accounts[accountKey] = account;
    await fs.writeFile(LOCAL.registry, JSON.stringify(latest, null, 2), {mode: LOCAL.mode});
  }
}
if (require.main === module) qualify().catch(error => { console.error(error instanceof Error ? error.message : 'Local Auth qualification failed'); process.exitCode = 1; });
module.exports = {captured, auth};
