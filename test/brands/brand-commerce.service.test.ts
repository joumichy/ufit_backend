import {describe, expect, it, vi} from 'vitest';
import {NotFoundException} from '@nestjs/common';
import {BrandCommerceService} from '../../src/modules/brands/brand-commerce.service';
import {BrandsService} from '../../src/modules/brands/brands.service';
import type {BrandsRepository, BrandCommerceAccess} from '../../src/modules/brands/brands.repository';
import {brandCommercePolicySchema, updateBrandCommercePolicySchema, type BrandCommercePolicy} from '../../src/modules/brands/commerce-policy';

type Settings = NonNullable<Awaited<ReturnType<BrandsRepository['findSettings']>>>;
const fixture = {
  brandID: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', actor: {id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},
  timestamp: new Date('2026-05-20T00:00:00.000Z'), invalid: 'Commerce fixture received an invalid contract', failure: 'Injected transaction failure',
  policy: {returnWindowDays: 21, returnPolicy: 'Retour demandé depuis la commande.', pricesIncludeTaxes: false,
    taxNotice: 'Taxe affichée avant paiement.', customsNotice: 'Douane à la charge du destinataire.', shippingRates: [
      {country: 'CH', currency: 'CHF', amount: 800, taxBasisPoints: 810, taxOnShipping: true},
      {country: 'JP', currency: 'JPY', amount: 1500, taxBasisPoints: 1000, taxOnShipping: false},
      {country: 'BH', currency: 'BHD', amount: 1250, taxBasisPoints: 1000, taxOnShipping: false},
    ]} satisfies BrandCommercePolicy,
};
function setup() {
  let settings: Settings | undefined;
  let failAfterWrite = false;
  const context: BrandCommerceAccess = {brand: {id: fixture.brandID, brandName: 'Maison', status: 'paused'},
    actor: {status: 'active', roles: ['brand_owner']}, memberRole: 'owner'};
  function access(brandID: string, actorID: string) {
    if (brandID !== fixture.brandID || actorID !== fixture.actor.id) throw new Error(fixture.invalid);
    return structuredClone(context);
  }
  const unsupported = async () => {throw new Error(fixture.invalid);};
  const port: BrandsRepository = {
    findProfileByApplicationId: unsupported, findProfileById: unsupported, createProfile: unsupported,
    createOwnerMember: unsupported, createDefaultSettings: unsupported, findActiveMember: unsupported, updateProfile: unsupported,
    findPublicProfileById: async (brandID: string) => {
      if (brandID !== fixture.brandID) throw new Error(fixture.invalid);
      return context.brand.status === 'active' ? {...context.brand, slug: 'maison', bio: null, websiteUrl: null, stats: {publishedOutfits: 0, activeProducts: 0}} : undefined;
    },
    transaction: async <T>(operation: (repository: BrandsRepository) => Promise<T>): Promise<T> => {
      const before = structuredClone(settings);
      try { return await operation(port); } catch (error) { settings = before; throw error; }
    },
    snapshot: async <T>(operation: (repository: BrandsRepository) => Promise<T>): Promise<T> => operation(port),
    findCommerceAccess: vi.fn(async (brandID: string, actorID: string) => access(brandID, actorID)),
    lockCommerceAccess: vi.fn(async (brandID: string, actorID: string) => access(brandID, actorID)),
    findSettings: async (brandID: string) => {
      if (brandID !== fixture.brandID) throw new Error(fixture.invalid);
      return structuredClone(settings);
    },
    saveCommercePolicy: vi.fn(async (brandID: string, policy: BrandCommercePolicy, expectedVersion: number) => {
      if (brandID !== fixture.brandID || !brandCommercePolicySchema.safeParse(policy).success || !Number.isInteger(expectedVersion)) throw new Error(fixture.invalid);
      if ((settings?.commercePolicyVersion ?? 0) !== expectedVersion) return undefined;
      settings = {...settings, brandProfileId: brandID, fulfillmentEmail: null, returnPolicyUrl: null, autoApproveProducts: false,
        metadata: {...settings?.metadata, commercePolicy: structuredClone(policy)}, commercePolicyVersion: expectedVersion + 1, updatedAt: fixture.timestamp};
      if (failAfterWrite) throw new Error(fixture.failure);
      return structuredClone(settings);
    }),
  };
  const profiles = new BrandsService(port);
  vi.spyOn(profiles, 'getPublicProfile');
  return {service: new BrandCommerceService(port, profiles), port, profiles, context,
    get settings() {return settings;}, set settings(value: Settings | undefined) {settings = value;},
    failAfterWrite: () => {failAfterWrite = true;}};
}

describe('BrandCommerceService', () => {
  it('reads a paused member draft as an explicit unconfigured version, without a public lookup', async () => {
    const {service, profiles} = setup();
    expect(await service.readManaged(fixture.brandID, fixture.actor)).toEqual({brandId: fixture.brandID, version: 0, policy: null});
    expect(profiles.getPublicProfile).not.toHaveBeenCalled();
    await expect(service.read(fixture.brandID)).rejects.toBeInstanceOf(NotFoundException);
  });
  it('creates a versioned policy for a paused member and refuses a stale write without overwriting it', async () => {
    const state = setup();
    expect(await state.service.update(fixture.brandID, fixture.actor, {expectedVersion: 0, policy: fixture.policy})).toEqual({brandId: fixture.brandID, version: 1, policy: fixture.policy});
    await expect(state.service.update(fixture.brandID, fixture.actor, {expectedVersion: 0, policy: {...fixture.policy, returnWindowDays: 7}}))
      .rejects.toMatchObject({response: {code: 'brand_policy_version_changed'}});
    expect(state.settings?.commercePolicyVersion).toBe(1);
    expect(state.settings?.metadata.commercePolicy).toEqual(fixture.policy);
    expect(state.port.lockCommerceAccess).toHaveBeenCalledWith(fixture.brandID, fixture.actor.id);
  });
  it('preserves unrelated metadata and returns the same canonical policy to public checkout only while active', async () => {
    const state = setup();
    state.settings = {brandProfileId: fixture.brandID, fulfillmentEmail: null, returnPolicyUrl: null, autoApproveProducts: false,
      commercePolicyVersion: 0, metadata: {unrelated: {preserved: true}}, updatedAt: fixture.timestamp};
    await state.service.update(fixture.brandID, fixture.actor, {expectedVersion: 0, policy: fixture.policy});
    expect(state.settings?.metadata.unrelated).toEqual({preserved: true});
    state.context.brand.status = 'active';
    expect(await state.service.read(fixture.brandID)).toEqual(fixture.policy);
    expect(await state.service.readManaged(fixture.brandID, fixture.actor)).toEqual({brandId: fixture.brandID, version: 1, policy: fixture.policy});
  });
  it.each(['removed membership', 'revoked role', 'suspended actor', 'suspended brand', 'draft brand'] as const)('refuses %s using current persisted access facts', async scenario => {
    const state = setup();
    if (scenario === 'removed membership') state.context.memberRole = null;
    if (scenario === 'revoked role') state.context.actor.roles = ['customer'];
    if (scenario === 'suspended actor') state.context.actor.status = 'suspended';
    if (scenario === 'suspended brand') state.context.brand.status = 'suspended';
    if (scenario === 'draft brand') state.context.brand.status = 'draft';
    const forged = {...fixture.actor, roles: ['super_admin']};
    await expect(state.service.readManaged(fixture.brandID, forged)).rejects.toMatchObject({response: {code: 'brand_policy_access_required'}});
    await expect(state.service.update(fixture.brandID, forged, {expectedVersion: 0, policy: fixture.policy})).rejects.toMatchObject({status: 403});
    expect(state.port.saveCommercePolicy).not.toHaveBeenCalled();
  });
  it('retains administrator access without granting it through the supplied actor object', async () => {
    const state = setup(); state.context.memberRole = null; state.context.actor.roles = ['admin'];
    expect((await state.service.update(fixture.brandID, fixture.actor, {expectedVersion: 0, policy: fixture.policy})).version).toBe(1);
  });
  it('rolls back a write when the repository fails before transaction completion', async () => {
    const state = setup(); state.failAfterWrite();
    await expect(state.service.update(fixture.brandID, fixture.actor, {expectedVersion: 0, policy: fixture.policy})).rejects.toThrow(fixture.failure);
    expect(state.settings).toBeUndefined();
  });
  it('rejects malformed persisted data and inconsistent policy revision', async () => {
    const state = setup();
    state.settings = {brandProfileId: fixture.brandID, fulfillmentEmail: null, returnPolicyUrl: null, autoApproveProducts: false,
      commercePolicyVersion: 1, metadata: {}, updatedAt: fixture.timestamp};
    await expect(state.service.readManaged(fixture.brandID, fixture.actor)).rejects.toMatchObject({response: {code: 'brand_policy_invalid'}});
    state.settings.metadata = {commercePolicy: {...fixture.policy, shippingRates: []}};
    await expect(state.service.readManaged(fixture.brandID, fixture.actor)).rejects.toMatchObject({status: 409});
  });
  it('requires the versioned body and authoritative country/currency codes without aliases', () => {
    expect(updateBrandCommercePolicySchema.safeParse(fixture.policy).success).toBe(false);
    expect(updateBrandCommercePolicySchema.safeParse({expectedVersion: -1, policy: fixture.policy}).success).toBe(false);
    expect(updateBrandCommercePolicySchema.safeParse({expectedVersion: 0, policy: fixture.policy, actorId: fixture.actor.id}).success).toBe(false);
    for (const patch of [{country: 'ZZ'}, {currency: 'ZZZ'}, {amount: -1}, {amount: 1.5}, {taxBasisPoints: 10001}]) {
      expect(brandCommercePolicySchema.safeParse({...fixture.policy, shippingRates: [{...fixture.policy.shippingRates[0], ...patch}]}).success).toBe(false);
    }
    expect(brandCommercePolicySchema.safeParse({...fixture.policy, shippingRates: [fixture.policy.shippingRates[0], fixture.policy.shippingRates[0]]}).success).toBe(false);
    expect(brandCommercePolicySchema.safeParse({...fixture.policy, shippingRates: [fixture.policy.shippingRates[0], {...fixture.policy.shippingRates[0], currency: 'EUR'}]}).success).toBe(true);
  });
});
