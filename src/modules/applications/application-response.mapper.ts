import type {
  ApplicationReviewRow,
  BrandApplicationRow,
  CreatorApplicationRow
} from '../../shared/infrastructure/database/schema';

export function mapCreatorApplication(row: CreatorApplicationRow): Record<string, unknown> {
  return {
    id: row.id,
    type: 'creator',
    userId: row.userId,
    displayName: row.displayName,
    email: row.email,
    portfolioUrl: row.portfolioUrl,
    audienceSummary: row.audienceSummary,
    status: row.status,
    submittedAt: row.submittedAt,
    updatedAt: row.updatedAt
  };
}

export function mapBrandApplication(row: BrandApplicationRow): Record<string, unknown> {
  return {
    id: row.id,
    type: 'brand',
    userId: row.userId,
    brandName: row.brandName,
    email: row.email,
    websiteUrl: row.websiteUrl,
    productCategory: row.productCategory,
    status: row.status,
    submittedAt: row.submittedAt,
    updatedAt: row.updatedAt
  };
}

export function mapApplicationReview(row: ApplicationReviewRow): Record<string, unknown> {
  return {
    id: row.id,
    applicationType: row.applicationType,
    applicationId: row.applicationId,
    decision: row.decision,
    notes: row.notes,
    createdAt: row.createdAt
  };
}
