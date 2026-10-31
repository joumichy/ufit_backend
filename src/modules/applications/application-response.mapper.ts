import type { ApplicationReviewRow, BrandApplicationRow, CreatorApplicationRow } from "../../shared/infrastructure/database/schema";
import { APPLICATION } from "./types/application-contract";
export function mapCreatorApplication(row: CreatorApplicationRow, review: ApplicationReviewRow | null) {
  return {id: row.id, type: APPLICATION.kind.creator, userId: row.userId, displayName: row.displayName,
    email: row.email, portfolioUrl: row.portfolioUrl, motivation: row.motivation, audienceSummary: row.audienceSummary,
    dossier: row.dossier, version: row.version, status: row.status, submittedAt: row.submittedAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    latestReview: review ? mapApplicationReview(review) : null};
}
export function mapBrandApplication(row: BrandApplicationRow, review: ApplicationReviewRow | null) {
  return {id: row.id, type: APPLICATION.kind.brand, userId: row.userId, brandName: row.brandName,
    email: row.email, websiteUrl: row.websiteUrl, productCategory: row.productCategory, positioning: row.positioning,
    dossier: row.dossier, version: row.version, status: row.status, submittedAt: row.submittedAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    latestReview: review ? mapApplicationReview(review) : null};
}
export function mapApplicationReview(row: ApplicationReviewRow) {
  return {id: row.id, applicationType: row.applicationType, applicationId: row.applicationId,
    decision: row.decision, notes: row.notes, createdAt: row.createdAt.toISOString()};
}
