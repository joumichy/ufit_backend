import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { BrandsService } from '../../src/modules/brands/brands.service';
import type { BrandsRepository } from '../../src/modules/brands/brands.repository';
import type { BrandApplicationRow, BrandMemberRow, BrandProfileRow } from '../../src/shared/infrastructure/database/schema';

const now = new Date('2026-05-20T00:00:00.000Z');

function brandProfile(overrides: Partial<BrandProfileRow> = {}): BrandProfileRow {
  return {
    id: '44444444-4444-4444-4444-444444444444',
    ownerUserId: '22222222-2222-2222-2222-222222222222',
    applicationId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    brandName: 'North Line',
    slug: 'north-line-bbbbbbbb',
    websiteUrl: 'https://example.com',
    bio: null,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function member(overrides: Partial<BrandMemberRow> = {}): BrandMemberRow {
  return {
    id: '55555555-5555-5555-5555-555555555555',
    brandProfileId: '44444444-4444-4444-4444-444444444444',
    userId: '22222222-2222-2222-2222-222222222222',
    role: 'owner',
    status: 'active',
    createdAt: now,
    ...overrides
  };
}

function application(): BrandApplicationRow {
  return {
    id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    userId: '22222222-2222-2222-2222-222222222222',
    brandName: 'North Line',
    email: 'brand@example.com',
    websiteUrl: 'https://example.com',
    productCategory: 'Outerwear',
    positioning: 'Responsible outerwear for editorial outfits.',
    dossier: null,
    version: 1,
    status: 'accepted',
    submittedAt: now,
    updatedAt: now
  };
}

function buildService(repositoryOverrides: Partial<BrandsRepository> = {}) {
  const repository: BrandsRepository = {
    findSettings: vi.fn().mockResolvedValue(undefined),
    saveCommercePolicy: async () => {throw new Error('Commerce policy is outside this profile fixture');},
    findProfileByApplicationId: vi.fn().mockResolvedValue(undefined),
    findProfileById: vi.fn().mockResolvedValue(brandProfile()),
    createProfile: vi.fn().mockResolvedValue(brandProfile()),
    createOwnerMember: vi.fn().mockResolvedValue(member()),
    createDefaultSettings: vi.fn().mockResolvedValue(undefined),
    findActiveMember: vi.fn().mockResolvedValue(member()),
    updateProfile: vi.fn().mockResolvedValue(brandProfile({ bio: 'Updated' })),
    ...repositoryOverrides
  };

  return { service: new BrandsService(repository), repository };
}

describe('BrandsService', () => {
  it('provisions brand profile, owner member and settings from an accepted application', async () => {
    const { service, repository } = buildService();

    await service.provisionFromApplication(application());

    expect(repository.createProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId: '22222222-2222-2222-2222-222222222222',
        slug: 'north-line-bbbbbbbb'
      })
    );
    expect(repository.createOwnerMember).toHaveBeenCalledWith(
      expect.objectContaining({
        brandProfileId: '44444444-4444-4444-4444-444444444444',
        role: 'owner'
      })
    );
    expect(repository.createDefaultSettings).toHaveBeenCalledWith('44444444-4444-4444-4444-444444444444');
  });

  it('requires active membership before reading a brand profile', async () => {
    const { service } = buildService({
      findActiveMember: vi.fn().mockResolvedValue(undefined)
    });

    await expect(
      service.getProfileForMember('44444444-4444-4444-4444-444444444444', '99999999-9999-9999-9999-999999999999')
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('updates a brand profile for an active member', async () => {
    const { service, repository } = buildService();

    await expect(
      service.updateProfileForMember('44444444-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222', {
        bio: 'Updated'
      })
    ).resolves.toMatchObject({ bio: 'Updated' });
    expect(repository.updateProfile).toHaveBeenCalledWith('44444444-4444-4444-4444-444444444444', { bio: 'Updated' });
  });

  it('returns not found before checking membership when the brand profile is missing', async () => {
    const { service } = buildService({
      findProfileById: vi.fn().mockResolvedValue(undefined)
    });

    await expect(
      service.getProfileForMember('44444444-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222')
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
