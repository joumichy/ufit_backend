import type {NotificationsWriter} from "../../notifications/domain/notification.contract";
import type { UserRole } from "../../identity/domain/user.types";
import type { BrandApplicationDossier, CreatorApplicationDossier, ApplicationKind } from "./application-contract";
import type {
  ApplicationReviewRow,
  BrandApplicationRow,
  CreatorApplicationRow
} from '../../../shared/infrastructure/database/schema';

export type ApplicationType = ApplicationKind;
export type ApplicationDecision = 'accept' | 'reject' | 'waitlist' | 'needs_more_info';
export type ApplicationStatus = CreatorApplicationRow['status'];

export interface SubmitCreatorApplicationInput {
  userId: string;
  displayName: string;
  email: string;
  portfolioUrl?: string | null;
  dossier: CreatorApplicationDossier;
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
  dossier: BrandApplicationDossier;
}

export interface ReviewApplicationInput {
  applicationType: ApplicationType;
  applicationId: string;
  reviewerUserId: string;
  decision: ApplicationDecision;
  expectedVersion: number;
  notes?: string;
}

export interface ApplicationsRepository {
  lockApplicant(userId: string, kind: ApplicationType): Promise<string | undefined>;
  hasCreatorProfile(userId: string): Promise<boolean>;
  lockCreatorApplication(id: string): Promise<CreatorApplicationRow | undefined>;
  lockBrandApplication(id: string): Promise<BrandApplicationRow | undefined>;
  updateCreatorApplication(id: string, input: SubmitCreatorApplicationInput): Promise<CreatorApplicationRow>;
  updateBrandApplication(id: string, input: SubmitBrandApplicationInput): Promise<BrandApplicationRow>;

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
export interface ApplicationWorkflowContext {
  notifications: NotificationsWriter;
  applications: ApplicationsRepository;
  provisioning: ProfileProvisioningPort;
  identity: { ensureRole(userId: string, role: UserRole): Promise<void> };
}
export interface ApplicationWorkflow { run<T>(operation: (context: ApplicationWorkflowContext) => Promise<T>): Promise<T>; }
export const APPLICATION_WORKFLOW = Symbol("APPLICATION_WORKFLOW");
