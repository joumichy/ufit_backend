import { createClient } from '@supabase/supabase-js';
import { Pool } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getEnv } from '../src/config/env';
import { buildPgSslConfig } from '../src/shared/infrastructure/database/pg-ssl';

type Account = { email: string; password: string; authId?: string; userId?: string; applicationId?: string; profileId?: string; displayName?: string };
type Registry = { customer: Account; creator?: Account; brand?: Account; admin?: Account; qualification?: { image: string; productIds: string[]; outfitId?: string; tag: string } };
const environment = getEnv();
if (environment.NODE_ENV !== 'development') throw new Error('Qualification seeding requires the development runtime');
if (!environment.SUPABASE_SECRET_KEY || !environment.SUPABASE_PUBLIC_KEY) throw new Error('Ufit qualification authority is not configured');
const registryDirectory = path.join(os.homedir(), '.codex/private/ufit');
const registryPath = path.join(registryDirectory, 'qualification.credentials.json');
await mkdir(registryDirectory, {recursive: true, mode: 0o700});
const registry: Registry = JSON.parse(await readFile(registryPath, 'utf8'));
async function persist() { await writeFile(registryPath, JSON.stringify(registry, null, 2), {mode: 0o600}); }
const authority = createClient(environment.SUPABASE_URL, environment.SUPABASE_SECRET_KEY, {auth: {persistSession: false, autoRefreshToken: false}});
const pool = new Pool({connectionString: environment.SUPABASE_DIRECT_CONNECTION_DB_URL, ssl: buildPgSslConfig(environment)});
const schema = `"${environment.UFIT_DB_SCHEMA}"`;
const origin = `http://127.0.0.1:${environment.API_PORT}`;
async function token(account: Account) {
  const client = createClient(environment.SUPABASE_URL, environment.SUPABASE_PUBLIC_KEY!, {auth: {persistSession: false, autoRefreshToken: false}});
  const {data, error} = await client.auth.signInWithPassword({email: account.email, password: account.password});
  if (error || !data.session) throw new Error('Qualification sign-in failed');
  return data.session.access_token;
}
async function api(account: Account, route: string, method = 'GET', body?: unknown) {
  const response = await fetch(origin + '/' + route, {method, headers: {Authorization: 'Bearer ' + await token(account), 'Content-Type': 'application/json'}, body: body ? JSON.stringify(body) : undefined});
  if (!response.ok) throw new Error(`Qualification API rejected ${method} ${route.split('/')[0]} (${response.status})`);
  return response.json();
}
try {
  for (const role of ['creator','brand','admin'] as const) {
    registry[role] ??= {email: `ufit-qa-${randomUUID()}@example.test`, password: randomBytes(24).toString('base64url')};
    await persist();
    const account = registry[role]!;
    if (!account.authId) {
      const {data, error} = await authority.auth.admin.createUser({email: account.email, password: account.password, email_confirm: true, user_metadata: {full_name: 'Qualification Ufit', ufit_qualification: true}});
      if (error || !data.user) throw new Error('Qualification account provisioning failed');
      account.authId = data.user.id;
      await persist();
    }
    account.userId = (await api(account, 'me')).id;
    await persist();
  }
  const admin = registry.admin!;
  const {data: verifiedAdmin} = await authority.auth.admin.getUserById(admin.authId!);
  if (!verifiedAdmin.user?.user_metadata.ufit_qualification) throw new Error('Only the private qualification account may be bootstrapped');
  await pool.query(`insert into ${schema}.user_roles (user_id, role) values ($1, $2) on conflict (user_id,role) do nothing`, [admin.userId, 'super_admin']);
  for (const role of ['creator','brand'] as const) {
    const account = registry[role]!;
    if (!account.applicationId) {
      const payload = role === 'creator' ? {displayName: 'Créateur Ufit — Qualification', email: account.email, portfolioUrl: 'https://example.test/ufit-qualification', motivation: 'Qualification des parcours de création et publication de tenues Ufit.'}
        : {brandName: 'Marque Ufit — Qualification', email: account.email, websiteUrl: 'https://example.test/ufit-qualification', productCategory: 'Vêtements', positioning: 'Catalogue de qualification du commerce Ufit en environnement de développement.'};
      account.applicationId = (await api(account, `applications/${role === 'creator' ? 'creators' : 'brands'}`, 'POST', payload)).id;
      await persist();
    }
    const table = role === 'creator' ? 'creator_applications' : 'brand_applications';
    const {rows} = await pool.query(`select status from ${schema}.${table} where id=$1`,[account.applicationId]);
    const requiredRole = role === 'creator' ? 'creator' : 'brand_owner';
    const roles = (await api(account, 'me')).roles as string[];
    if (rows[0]?.status !== 'accepted' || !roles.includes(requiredRole)) await api(admin, `admin/applications/${role}/${account.applicationId}/reviews`, 'POST', {decision:'accept'});
    const profiles = role === 'creator' ? 'creator_profiles' : 'brand_profiles';
    const {rows: profilesRows} = await pool.query(`select id from ${schema}.${profiles} where application_id=$1`,[account.applicationId]);
    account.profileId = profilesRows[0]?.id;
    if (!account.profileId) throw new Error('Accepted qualification application has no profile');
    await persist();
  }
  if (!registry.qualification) {
    const source = await readFile(path.resolve('../design/src/app/components/CreatorProfile.tsx'), 'utf8');
    const image = source.match(/https:\/\/images\.unsplash\.com\/[^'"\s]+/)?.[0];
    if (!image) throw new Error('Existing Ufit reference image is unavailable');
    registry.qualification = {image, productIds: [], tag: randomUUID().slice(0,8)};
    await persist();
  }
  const fixture = registry.qualification;
  const definitions = [{currency:'CHF', name:'Chemise de qualification', category:'top', amount:12990}, {currency:'EUR', name:'Veste de qualification', category:'outerwear', amount:18900}];
  for (const [position, definition] of definitions.entries()) {
    if (!fixture.productIds[position]) {
      const detail = await api(registry.brand!, 'products', 'POST', {brandId: registry.brand!.profileId, name: definition.name, slug: `qualification-${fixture.tag}-${position}`, description:'Pièce de qualification des parcours Ufit. Ce contenu est destiné au développement.', category:definition.category, currency:definition.currency, basePrice:definition.amount,
        variants:[{sku:`QA-${fixture.tag}-${position}-S`,size:'S',color:'Noir',stockQuantity:10},{sku:`QA-${fixture.tag}-${position}-M`,size:'M',color:'Noir',stockQuantity:10}], images:[{url:fixture.image,position:0,kind:'product'}]});
      fixture.productIds[position] = detail.product.id;
      await persist();
    }
    const id = fixture.productIds[position];
    const {rows} = await pool.query(`select status from ${schema}.products where id=$1`,[id]);
    if (rows[0]?.status === 'draft') await api(registry.brand!,'products/'+id+'/submit','PATCH');
    if (rows[0]?.status !== 'active') await api(admin,'products/'+id+'/review','PATCH',{decision:'active'});
  }
  if (!fixture.outfitId) {
    const detail = await api(registry.creator!,'outfits','POST',{creatorId:registry.creator!.profileId,title:'Tenue de qualification Ufit',description:'Tenue réservée à la qualification du parcours de découverte et d’achat.',coverImageUrl:fixture.image,
      items:fixture.productIds.map((productId,position)=>({productId,itemType:definitions[position].category,position,isRequired:true,isShoppable:true}))});
    fixture.outfitId = detail.outfit.id;
    await persist();
  }
  const {rows} = await pool.query(`select status from ${schema}.outfits where id=$1`,[fixture.outfitId]);
  if (rows[0]?.status === 'draft') await api(registry.creator!,'outfits/'+fixture.outfitId+'/submit','PATCH');
  if (rows[0]?.status !== 'published') await api(admin,'outfits/'+fixture.outfitId+'/review','PATCH',{decision:'published'});
  console.log('Qualification Ufit : comptes, candidatures, produits et tenue disponibles.');
} finally { await pool.end(); }
