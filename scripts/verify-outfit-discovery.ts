import 'reflect-metadata';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {eq} from 'drizzle-orm';
import {getEnv} from '../src/config/env';
import {buildPgSslConfig} from '../src/shared/infrastructure/database/pg-ssl';
import {quoteIdentifier} from '../src/shared/infrastructure/database/quote-identifier';
import * as schema from '../src/shared/infrastructure/database/schema';
import {DrizzleOutfitRepository} from '../src/modules/outfits/infrastructure/drizzle-outfit.repository';
import {OUTFIT_STATUS as S, OUTFIT_VISIBILITY as V, OUTFIT_ITEM_TYPES} from '../src/modules/outfits/domain/outfit-editing.contract';
import {OUTFIT_DISCOVERY as D, PUBLIC_OUTFIT, type PublicOutfitPage} from '../src/modules/outfits/domain/public-outfit.contract';
import {PRODUCT_STATUS} from '../src/modules/products/domain/product-contract';
import {PROFILE_STATUS} from '../src/shared/domain/profile-editing.contract';
import {USER_ADMINISTRATION} from '../src/modules/identity/domain/user-administration.contract';

const P = {
  profile: {node: 'development', port: 4014, schema: 'ufit', stripe: 'sk_test_'},
  zero: 0, one: 1, two: 2, count: 21, page: 20, readLimit: 50,
  domain: '@example.invalid', image: 'https://example.invalid/discovery.jpg', site: 'https://example.invalid',
  creator: 'Discovery Creator ', brand: 'Discovery Brand ', product: 'Discovery Product ', description: 'Discovery rollback qualification',
  constraint: 'outfits_owner_exclusive', checkViolation: '23514',
  currency: 'CHF', amount: 10000, literal: '%_\\', injection: "'); select pg_sleep(9); --",
  separator: ' ', style: D.tag.style, occasion: D.tag.occasion,
  checks: {
    creator_scope_excludes_brand_author: 'creator_scope_excludes_brand_author',
    brand_author_search: 'brand_author_search',
    suspended_creator_account_hidden: 'suspended_creator_account_hidden',
    paused_creator_hidden: 'paused_creator_hidden',
    draft_outfit_hidden: 'draft_outfit_hidden',
    private_outfit_hidden: 'private_outfit_hidden',
    paused_brand_does_not_match_product: 'paused_brand_does_not_match_product',
    hidden_product_does_not_match_type: 'hidden_product_does_not_match_type',
    hidden_product_does_not_match: 'hidden_product_does_not_match',
    piece_query_and_type_same_piece: 'piece_query_and_type_same_piece',
    piece_type: 'piece_type',
    injection_is_literal: 'injection_is_literal',
    literal_sql_wildcards: 'literal_sql_wildcards',
    brand_name_from_piece: 'brand_name_from_piece',
    product_name_search: 'product_name_search',
    piece_scope_does_not_search_author: 'piece_scope_does_not_search_author',
    creator_name_case_insensitive: 'creator_name_case_insensitive',
    unknown_tag_is_empty: 'unknown_tag_is_empty',
    wrong_tag_type_is_empty: 'wrong_tag_type_is_empty',
    occasion_and_style_intersection: 'occasion_and_style_intersection',
    style_filter: 'style_filter',
    query_applied_before_20_plus_1_pagination: 'query_applied_before_20_plus_1_pagination',
    ambiguous_owner_rejected_by_database: 'ambiguous_owner_rejected_by_database',
  },
  failed: 'Outfit discovery verification failed; transaction rolled back.', diagnostic: '/tmp/ufit-discovery-verification.txt',
  sql: {tables: "select table_name from information_schema.tables where table_schema=$1 and table_type='BASE TABLE' order by table_name",
    digest: "select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) digest from ", alias: ' t', separator: '.'},
} as const;
class Rollback extends Error {}
async function verify() {
  const env = getEnv();
  assert(env.NODE_ENV === P.profile.node && env.API_PORT === P.profile.port && env.UFIT_DB_SCHEMA === P.profile.schema &&
    env.STRIPE_SECRET_KEY?.startsWith(P.profile.stripe) && !env.NOTIFICATION_PUSH_ENABLED && !env.NOTIFICATION_EMAIL_ENABLED);
  const pool = new Pool({connectionString: env.SUPABASE_DIRECT_CONNECTION_DB_URL, ssl: buildPgSslConfig(env), max: P.one});
  const client = await pool.connect(), database = drizzle(client, {schema}), checks: string[] = [];
  const tables = (await client.query<{table_name: string}>(P.sql.tables, [env.UFIT_DB_SCHEMA])).rows.map(row => row.table_name);
  const fingerprint = async (table: string) => (await client.query(P.sql.digest + quoteIdentifier(env.UFIT_DB_SCHEMA) + P.sql.separator + quoteIdentifier(table) + P.sql.alias)).rows[P.zero].digest;
  const before = new Map<string, string>();
  try {
    for (const table of tables) before.set(table, await fingerprint(table));
    try {
      await database.transaction(async db => {
        const key = randomUUID(), creatorName = P.creator + key, brandName = P.brand + key, productName = P.product + key;
        const [user] = await db.insert(schema.users).values({supabaseUserId: randomUUID(), email: key + P.domain, status: USER_ADMINISTRATION.status.active}).returning();
        const [application] = await db.insert(schema.creatorApplications).values({userId: user.id, email: user.email, displayName: creatorName, motivation: P.description}).returning();
        const [creator] = await db.insert(schema.creatorProfiles).values({userId: user.id, applicationId: application.id, displayName: creatorName, slug: randomUUID(), status: PROFILE_STATUS.active}).returning();
        const [brandApplication] = await db.insert(schema.brandApplications).values({userId: user.id, email: user.email, brandName, websiteUrl: P.site, productCategory: P.description, positioning: P.description}).returning();
        const [brand] = await db.insert(schema.brandProfiles).values({ownerUserId: user.id, applicationId: brandApplication.id, brandName, slug: randomUUID(), status: PROFILE_STATUS.active}).returning();
        const [product] = await db.insert(schema.products).values({brandId: brand.id, name: productName, slug: randomUUID(), description: P.description, category: P.description,
          basePrice: P.amount, currency: P.currency, status: PRODUCT_STATUS.active}).returning();
        const tagRows = await db.insert(schema.tags).values([P.style, P.occasion].map(type => ({type, slug: randomUUID(), label: P.description}))).returning();
        const [style, occasion] = tagRows;
        const rows = await db.insert(schema.outfits).values(Array.from({length: P.count}, (_, i) => ({creatorId: creator.id, title: key + P.separator + i,
          description: P.description, coverImageUrl: P.image, status: S.published, visibility: V.public}))).returning();
        const [first, second] = rows;
        await db.insert(schema.outfitItems).values([
          {outfitId: first.id, productId: product.id, itemType: OUTFIT_ITEM_TYPES[P.zero], position: P.zero, isRequired: true, isShoppable: true},
          {outfitId: second.id, externalLabel: P.literal, itemType: OUTFIT_ITEM_TYPES[P.one], position: P.zero, isRequired: true, isShoppable: false},
        ]);
        await db.insert(schema.outfitTags).values([{outfitId: first.id, tagId: style.id}, {outfitId: first.id, tagId: occasion.id}, {outfitId: second.id, tagId: style.id}]);
        const repository = new DrizzleOutfitRepository({db});
        const ids = async (input: Omit<PublicOutfitPage, 'limit'>, limit: number = P.readLimit) => (await repository.findPublishedPage({...input, limit})).map(detail => detail.outfit.id);
        const expectIDs = async (name: string, input: Omit<PublicOutfitPage, 'limit'>, expected: string[]) => {
          assert.deepEqual((await ids(input)).sort(), [...expected].sort()); checks.push(name);
        };
        const initial = await ids({q: key}, P.page), next = await ids({q: key, cursor: initial.at(-P.one)}, P.page);
        assert.equal(initial.length, P.page); assert.equal(next.length, P.one); assert.equal(new Set([...initial, ...next]).size, P.count);
        assert.deepEqual([...initial, ...next], rows.map(row => row.id).sort().reverse()); checks.push(P.checks.query_applied_before_20_plus_1_pagination);
        await expectIDs(P.checks.style_filter, {creatorId: creator.id, styleId: style.id}, [first.id, second.id]);
        await expectIDs(P.checks.occasion_and_style_intersection, {creatorId: creator.id, styleId: style.id, occasionId: occasion.id}, [first.id]);
        await expectIDs(P.checks.wrong_tag_type_is_empty, {creatorId: creator.id, styleId: occasion.id}, []);
        await expectIDs(P.checks.unknown_tag_is_empty, {creatorId: creator.id, styleId: randomUUID()}, []);
        await expectIDs(P.checks.creator_name_case_insensitive, {q: creatorName.toUpperCase(), scope: D.scope.creators}, rows.map(row => row.id));
        await expectIDs(P.checks.piece_scope_does_not_search_author, {q: creatorName, scope: D.scope.pieces}, []);
        await expectIDs(P.checks.product_name_search, {q: productName.toUpperCase(), scope: D.scope.pieces}, [first.id]);
        await expectIDs(P.checks.brand_name_from_piece, {q: brandName}, [first.id]);
        await expectIDs(P.checks.literal_sql_wildcards, {q: P.literal, scope: D.scope.pieces}, [second.id]);
        await expectIDs(P.checks.injection_is_literal, {q: P.injection}, []);
        await expectIDs(P.checks.piece_type, {creatorId: creator.id, itemType: OUTFIT_ITEM_TYPES[P.one]}, [second.id]);
        await expectIDs(P.checks.piece_query_and_type_same_piece, {q: P.literal, scope: D.scope.pieces, itemType: OUTFIT_ITEM_TYPES[P.zero]}, []);
        await db.update(schema.products).set({status: PRODUCT_STATUS.draft}).where(eq(schema.products.id, product.id));
        await expectIDs(P.checks.hidden_product_does_not_match, {q: productName}, []);
        await expectIDs(P.checks.hidden_product_does_not_match_type, {creatorId: creator.id, itemType: OUTFIT_ITEM_TYPES[P.zero]}, []);
        await db.update(schema.products).set({status: PRODUCT_STATUS.active}).where(eq(schema.products.id, product.id));
        await db.update(schema.brandProfiles).set({status: PROFILE_STATUS.paused}).where(eq(schema.brandProfiles.id, brand.id));
        await expectIDs(P.checks.paused_brand_does_not_match_product, {q: productName}, []);
        await db.update(schema.brandProfiles).set({status: PROFILE_STATUS.active}).where(eq(schema.brandProfiles.id, brand.id));
        await db.update(schema.outfits).set({visibility: V.private}).where(eq(schema.outfits.id, first.id));
        await expectIDs(P.checks.private_outfit_hidden, {q: productName}, []);
        await db.update(schema.outfits).set({visibility: V.public, status: S.draft}).where(eq(schema.outfits.id, first.id));
        await expectIDs(P.checks.draft_outfit_hidden, {q: productName}, []);
        await db.update(schema.outfits).set({status: S.published}).where(eq(schema.outfits.id, first.id));
        await db.update(schema.creatorProfiles).set({status: PROFILE_STATUS.paused}).where(eq(schema.creatorProfiles.id, creator.id));
        await expectIDs(P.checks.paused_creator_hidden, {q: creatorName, scope: D.scope.creators}, []);
        await db.update(schema.creatorProfiles).set({status: PROFILE_STATUS.active}).where(eq(schema.creatorProfiles.id, creator.id));
        await db.update(schema.users).set({status: USER_ADMINISTRATION.status.suspended}).where(eq(schema.users.id, user.id));
        await expectIDs(P.checks.suspended_creator_account_hidden, {q: creatorName, scope: D.scope.creators}, []);
        await db.update(schema.users).set({status: USER_ADMINISTRATION.status.active}).where(eq(schema.users.id, user.id));
        await db.update(schema.outfits).set({creatorId: null, brandId: brand.id}).where(eq(schema.outfits.id, first.id));
        await expectIDs(P.checks.brand_author_search, {q: brandName}, [first.id]);
        await expectIDs(P.checks.creator_scope_excludes_brand_author, {q: brandName, scope: D.scope.creators}, []);
        await assert.rejects(() => db.transaction(async tx => {
          await tx.update(schema.outfits).set({creatorId: creator.id}).where(eq(schema.outfits.id, first.id));
        }), error => {
          const cause = (error as {cause?: {code?: string; constraint?: string}}).cause;
          return cause?.code === P.checkViolation && cause.constraint === P.constraint;
        }); checks.push(P.checks.ambiguous_owner_rejected_by_database);
        throw new Rollback();
      });
    } catch (error) { if (!(error instanceof Rollback)) throw error; }
    for (const table of tables) assert.equal(await fingerprint(table), before.get(table));
    console.log(JSON.stringify({scenarios: checks.length, checks, rolledBack: true, unchangedTables: tables.length, providerCalls: P.zero}));
  } finally {client.release(); await pool.end();}
}
verify().catch(async error => {
  await writeFile(P.diagnostic, String(error) + String(error?.cause), {mode: 0o600});
  console.error(P.failed); process.exitCode = P.one;
});
