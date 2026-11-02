import { creatorDossier, brandDossier } from "./application-fixtures";
import type { ApplicationWorkflow } from "../../src/modules/applications/types/application.types";
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
    dossier: creatorDossier,
    version: 1,
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
    dossier: brandDossier,
    version: 1,
    status: 'submitted',
    submittedAt: now,
    updatedAt: now,
    ...overrides
  };
}

function buildService(repositoryOverrides: Partial<ApplicationsRepository> = {}) {
  const repository: ApplicationsRepository = {
    lockApplicant: vi.fn().mockResolvedValue("active"),
    hasCreatorProfile: vi.fn().mockResolvedValue(false),
    lockCreatorApplication: vi.fn().mockResolvedValue(creatorApplication()),
    lockBrandApplication: vi.fn().mockResolvedValue(brandApplication()),
    updateCreatorApplication: vi.fn().mockResolvedValue(creatorApplication({version: 3})),
    updateBrandApplication: vi.fn().mockResolvedValue(brandApplication({version: 3})),
    findActiveCreatorApplication: vi.fn().mockResolvedValue(undefined),
    findActiveBrandApplication: vi.fn().mockResolvedValue(undefined),
    createCreatorApplication: vi.fn().mockResolvedValue(creatorApplication()),
    createBrandApplication: vi.fn().mockResolvedValue(brandApplication()),
    findCreatorApplication: vi.fn().mockResolvedValue(creatorApplication()),
    findBrandApplication: vi.fn().mockResolvedValue(brandApplication()),
    updateCreatorApplicationStatus: vi.fn().mockResolvedValue(creatorApplication({ status: 'accepted', version: 2 })),
    updateBrandApplicationStatus: vi.fn().mockResolvedValue(brandApplication({ status: 'accepted', version: 2 })),
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
  const notifications = {record: vi.fn().mockResolvedValue("8de392a4-9161-4000-a927-57b826ce9d9a")};
  const workflow: ApplicationWorkflow = {run: operation => operation({applications: repository, provisioning, identity, notifications})};
  return { service: new ApplicationsService(repository, workflow), repository, provisioning, identity, notifications };
}

describe('ApplicationsService', () => {
  it('submits a creator application when no active application exists', async () => {
    const { service, repository } = buildService();

    await expect(
      service.submitCreatorApplication({
        dossier: creatorDossier,
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
        dossier: creatorDossier,
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
      expectedVersion: 1,
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
      updateBrandApplicationStatus: vi.fn().mockResolvedValue(brandApplication({ status: 'waitlisted', version: 2 }))
    });

    const result = await service.reviewApplication({
      expectedVersion: 1,
      applicationType: 'brand',
      applicationId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      reviewerUserId: '99999999-9999-9999-9999-999999999999',
      decision: 'waitlist',
      notes: 'Dossier en liste d’attente'
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
      expectedVersion: 1,
        applicationType: 'creator',
        applicationId: 'missing',
        reviewerUserId: '99999999-9999-9999-9999-999999999999',
        decision: 'reject'
      })
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('Application transactional notification intents', () => {
  it('records the account recipient, exact application and revision after submission', async () => {
    const {service,notifications}=buildService();
    const input=creatorApplication();
    const application=await service.submitCreatorApplication({userId:input.userId,displayName:input.displayName,email:input.email,motivation:input.motivation,dossier:creatorDossier});
    expect(notifications.record).toHaveBeenCalledOnce();
    expect(notifications.record).toHaveBeenCalledWith(expect.objectContaining({
      eventKey:'application/creator/'+application.id+'/1',recipientUserId:application.userId,
      resourceType:'creator_application',resourceId:application.id,audience:'applicant',brandId:null,
    }));
  });
  it('records the actual decision and required explanation with the new revision', async () => {
    const application=brandApplication({status:'needs_more_info',version:2});
    const {service,notifications}=buildService({updateBrandApplicationStatus:vi.fn().mockResolvedValue(application)});
    const notes='Précisez votre politique de retour.';
    await service.reviewApplication({applicationType:'brand',applicationId:application.id,reviewerUserId:application.userId,
      decision:'needs_more_info',expectedVersion:1,notes});
    expect(notifications.record).toHaveBeenCalledWith(expect.objectContaining({eventKey:'application/brand/'+application.id+'/2',
      resourceType:'brand_application',recipientUserId:application.userId,text:expect.stringContaining(notes)}));
  });
  it('does not invent another message when repairing an already accepted application', async () => {
    const application=creatorApplication({status:'accepted',version:2});
    const {service,notifications}=buildService({lockCreatorApplication:vi.fn().mockResolvedValue(application)});
    await service.reviewApplication({applicationType:'creator',applicationId:application.id,reviewerUserId:application.userId,decision:'accept',expectedVersion:2});
    expect(notifications.record).not.toHaveBeenCalled();
  });
  it('propagates an outbox failure to the transaction owner instead of accepting a partial decision', async () => {
    const {service,notifications}=buildService();
    const failure=new Error('Outbox storage unavailable');notifications.record.mockRejectedValueOnce(failure);
    await expect(service.reviewApplication({applicationType:'creator',applicationId:creatorApplication().id,
      reviewerUserId:creatorApplication().userId,decision:'accept',expectedVersion:1})).rejects.toBe(failure);
  });
});
