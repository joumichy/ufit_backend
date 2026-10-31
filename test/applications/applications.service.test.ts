import { ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ApplicationsService } from '../../src/modules/applications/applications.service';
import type { ApplicationsRepository, ProfileProvisioningPort } from '../../src/modules/applications/types/application.types';
import type { BrandApplicationRow, CreatorApplicationRow } from '../../src/shared/infrastructure/database/schema';

const now = new Date('2026-05-20T00:00:00.000Z');

function creatorApplication(overrides: Partial<CreatorApplicationRow> = {}): CreatorApplicationRow {
  return {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    userId: '11111111-1111-1111-1111-111111111111',
    displayName: 'Mira Studio',
    email: 'mira@example.com',
    portfolioUrl: 'https://example.com/mira',
    motivation: 'I curate sharp outfits for independent labels.',
    audienceSummary: null,
    status: 'submitted',
    submittedAt: now,
    updatedAt: now,
    ...overrides
  };
}

function brandApplication(overrides: Partial<BrandApplicationRow> = {}): BrandApplicationRow {
  return {
    id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    userId: '22222222-2222-2222-2222-222222222222',
    brandName: 'North Line',
    email: 'brand@example.com',
    websiteUrl: 'https://example.com',
    productCategory: 'Outerwear',
    positioning: 'Responsible outerwear for editorial outfits.',
    status: 'submitted',
    submittedAt: now,
    updatedAt: now,
    ...overrides
  };
}

function buildService(repositoryOverrides: Partial<ApplicationsRepository> = {}) {
  const repository: ApplicationsRepository = {
    findActiveCreatorApplication: vi.fn().mockResolvedValue(undefined),
    findActiveBrandApplication: vi.fn().mockResolvedValue(undefined),
    createCreatorApplication: vi.fn().mockResolvedValue(creatorApplication()),
    createBrandApplication: vi.fn().mockResolvedValue(brandApplication()),
    findCreatorApplication: vi.fn().mockResolvedValue(creatorApplication()),
    findBrandApplication: vi.fn().mockResolvedValue(brandApplication()),
    updateCreatorApplicationStatus: vi.fn().mockResolvedValue(creatorApplication({ status: 'accepted' })),
    updateBrandApplicationStatus: vi.fn().mockResolvedValue(brandApplication({ status: 'accepted' })),
    createReview: vi.fn().mockResolvedValue({
      id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      applicationType: 'creator',
      applicationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      reviewerUserId: '99999999-9999-9999-9999-999999999999',
      decision: 'accept',
      notes: null,
      createdAt: now
    }),
    ...repositoryOverrides
  };
  const provisioning: ProfileProvisioningPort = {
    provisionCreatorFromApplication: vi.fn().mockResolvedValue(undefined),
    provisionBrandFromApplication: vi.fn().mockResolvedValue(undefined)
  };

  const identity = { ensureRole: vi.fn().mockResolvedValue(undefined) };
  return { service: new ApplicationsService(repository, provisioning, identity), repository, provisioning, identity };
}

describe('ApplicationsService', () => {
  it('submits a creator application when no active application exists', async () => {
    const { service, repository } = buildService();

    await expect(
      service.submitCreatorApplication({
        userId: '11111111-1111-1111-1111-111111111111',
        displayName: 'Mira Studio',
        email: 'mira@example.com',
        portfolioUrl: 'https://example.com/mira',
        motivation: 'I curate sharp outfits for independent labels.'
      })
    ).resolves.toMatchObject({ status: 'submitted', displayName: 'Mira Studio' });

    expect(repository.createCreatorApplication).toHaveBeenCalledOnce();
  });

  it('rejects duplicate active creator submissions', async () => {
    const { service } = buildService({
      findActiveCreatorApplication: vi.fn().mockResolvedValue(creatorApplication())
    });

    await expect(
      service.submitCreatorApplication({
        userId: '11111111-1111-1111-1111-111111111111',
        displayName: 'Mira Studio',
        email: 'mira@example.com',
        portfolioUrl: 'https://example.com/mira',
        motivation: 'I curate sharp outfits for independent labels.'
      })
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('accepts a creator application and provisions the profile', async () => {
    const { service, repository, provisioning, identity } = buildService();

    const result = await service.reviewApplication({
      applicationType: 'creator',
      applicationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      reviewerUserId: '99999999-9999-9999-9999-999999999999',
      decision: 'accept',
      notes: 'Strong editorial fit'
    });

    expect(result.application.status).toBe('accepted');
    expect(repository.createReview).toHaveBeenCalledOnce();
    expect(provisioning.provisionCreatorFromApplication).toHaveBeenCalledOnce();
    expect(identity.ensureRole).toHaveBeenCalledWith(result.application.userId, 'creator');
  });

  it('waitlists a brand application without provisioning a profile', async () => {
    const { service, repository, provisioning } = buildService({
      updateBrandApplicationStatus: vi.fn().mockResolvedValue(brandApplication({ status: 'waitlisted' }))
    });

    const result = await service.reviewApplication({
      applicationType: 'brand',
      applicationId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      reviewerUserId: '99999999-9999-9999-9999-999999999999',
      decision: 'waitlist'
    });

    expect(result.application.status).toBe('waitlisted');
    expect(repository.createReview).toHaveBeenCalledOnce();
    expect(provisioning.provisionBrandFromApplication).not.toHaveBeenCalled();
  });

  it('fails review when the target application does not exist', async () => {
    const { service } = buildService({
      findCreatorApplication: vi.fn().mockResolvedValue(undefined)
    });

    await expect(
      service.reviewApplication({
        applicationType: 'creator',
        applicationId: 'missing',
        reviewerUserId: '99999999-9999-9999-9999-999999999999',
        decision: 'reject'
      })
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
