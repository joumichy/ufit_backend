import type {
  ApplicationReviewRow,
  BrandApplicationRow,
  CreatorApplicationRow
} from '../../../shared/infrastructure/database/schema';

export type ApplicationType = 'creator' | 'brand';
export type ApplicationDecision = 'accept' | 'reject' | 'waitlist' | 'needs_more_info';
export type ApplicationStatus = CreatorApplicationRow['status'];

export interface SubmitCreatorApplicationInput {
  userId: string;
  displayName: string;
  email: string;
  portfolioUrl: string;
  motivation: string;
  audienceSummary?: string;
}

export interface SubmitBrandApplicationInput {
  userId: string;
  brandName: string;
  email: string;
  websiteUrl: string;
  productCategory: string;
  positioning: string;
}

export interface ReviewApplicationInput {
  applicationType: ApplicationType;
  applicationId: string;
  reviewerUserId: string;
  decision: ApplicationDecision;
  notes?: string;
}

export interface ApplicationsRepository {
  findActiveCreatorApplication(userId: string): Promise<CreatorApplicationRow | undefined>;
  findActiveBrandApplication(userId: string): Promise<BrandApplicationRow | undefined>;
  createCreatorApplication(input: SubmitCreatorApplicationInput): Promise<CreatorApplicationRow>;
  createBrandApplication(input: SubmitBrandApplicationInput): Promise<BrandApplicationRow>;
  findCreatorApplication(applicationId: string): Promise<CreatorApplicationRow | undefined>;
  findBrandApplication(applicationId: string): Promise<BrandApplicationRow | undefined>;
  updateCreatorApplicationStatus(applicationId: string, status: ApplicationStatus): Promise<CreatorApplicationRow>;
  updateBrandApplicationStatus(applicationId: string, status: ApplicationStatus): Promise<BrandApplicationRow>;
  createReview(input: ReviewApplicationInput): Promise<ApplicationReviewRow>;
}

export interface ProfileProvisioningPort {
  provisionCreatorFromApplication(application: CreatorApplicationRow): Promise<void>;
  provisionBrandFromApplication(application: BrandApplicationRow): Promise<void>;
}

export const APPLICATIONS_REPOSITORY = Symbol('APPLICATIONS_REPOSITORY');
export const PROFILE_PROVISIONING_PORT = Symbol('PROFILE_PROVISIONING_PORT');
