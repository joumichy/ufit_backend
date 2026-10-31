import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { CreatorsService } from '../../src/modules/creators/creators.service';
import type { CreatorsRepository } from '../../src/modules/creators/creators.repository';
import type { CreatorApplicationRow, CreatorProfileRow } from '../../src/shared/infrastructure/database/schema';

const now = new Date('2026-05-20T00:00:00.000Z');

function profile(overrides: Partial<CreatorProfileRow> = {}): CreatorProfileRow {
  return {
    id: '33333333-3333-3333-3333-333333333333',
    userId: '11111111-1111-1111-1111-111111111111',
    applicationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    displayName: 'Mira Studio',
    slug: 'mira-studio-aaaaaaaa',
    bio: null,
    avatarUrl: null,
    status: 'active',
    gradeCode: 'seed',
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function application(): CreatorApplicationRow {
  return {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    userId: '11111111-1111-1111-1111-111111111111',
    displayName: 'Mira Studio',
    email: 'mira@example.com',
    portfolioUrl: 'https://example.com/mira',
    motivation: 'I curate sharp outfits for independent labels.',
    audienceSummary: null,
    dossier: null,
    version: 1,
    status: 'accepted',
    submittedAt: now,
    updatedAt: now
  };
}

function buildService(repositoryOverrides: Partial<CreatorsRepository> = {}) {
  const repository: CreatorsRepository = {
    findDetailsByUserId: vi.fn().mockResolvedValue({profile: profile(), socialAccounts: []}),
    findProfileByUserId: vi.fn().mockResolvedValue(profile()),
    findProfileByApplicationId: vi.fn().mockResolvedValue(undefined),
    createProfile: vi.fn().mockResolvedValue(profile()),
    updateProfile: vi.fn().mockResolvedValue(profile({ bio: 'Updated' })),
    addInitialGradeHistory: vi.fn().mockResolvedValue(undefined),
    ...repositoryOverrides
  };

  return { service: new CreatorsService(repository), repository };
}

describe('CreatorsService', () => {
  it('provisions a creator profile from an accepted application', async () => {
    const { service, repository } = buildService();

    await service.provisionFromApplication(application());

    expect(repository.createProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: '11111111-1111-1111-1111-111111111111',
        applicationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        slug: 'mira-studio-aaaaaaaa'
      })
    );
    expect(repository.addInitialGradeHistory).toHaveBeenCalledWith('33333333-3333-3333-3333-333333333333');
  });

  it('does not provision twice for the same application', async () => {
    const { service, repository } = buildService({
      findProfileByApplicationId: vi.fn().mockResolvedValue(profile())
    });

    await service.provisionFromApplication(application());

    expect(repository.createProfile).not.toHaveBeenCalled();
  });

  it('allows an active creator to update their own basic profile', async () => {
    const { service, repository } = buildService();

    await expect(service.updateOwnProfile('11111111-1111-1111-1111-111111111111', { bio: 'Updated' })).resolves.toMatchObject({
      bio: 'Updated'
    });
    expect(repository.updateProfile).toHaveBeenCalledWith('33333333-3333-3333-3333-333333333333', { bio: 'Updated' }, '11111111-1111-1111-1111-111111111111');
  });

  it('blocks suspended creators from updating their profile', async () => {
    const { service } = buildService({
      findProfileByUserId: vi.fn().mockResolvedValue(profile({ status: 'suspended' }))
    });

    await expect(service.updateOwnProfile('11111111-1111-1111-1111-111111111111', { bio: 'Nope' })).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });

  it('returns not found when the user has no creator profile', async () => {
    const { service } = buildService({
      findProfileByUserId: vi.fn().mockResolvedValue(undefined)
    });

    await expect(service.getOwnProfile('11111111-1111-1111-1111-111111111111')).rejects.toBeInstanceOf(NotFoundException);
  });
});
