export const APPLICATION = {
  kind: {creator: "creator", brand: "brand"},
  collection: {creator: "creators", brand: "brands"},
  status: {submitted: "submitted", underReview: "under_review", accepted: "accepted", rejected: "rejected", waitlisted: "waitlisted", needsMoreInfo: "needs_more_info"},
  decision: {accept: "accept", reject: "reject", waitlist: "waitlist", needsMoreInfo: "needs_more_info"},
  role: {creator: "creator", brand: "brand_owner"},
  applicantStatus: {active: "active", onboarding: "onboarding"},
  limits: {zero: 0, nameMin: 2, creatorNameMax: 80, brandNameMax: 120, shortMax: 80, textMin: 20, textMax: 2000, optionalMin: 5, optionalMax: 1000, detailMin: 2, examples: 3, initialVersion: 1, versionStep: 1, row: 1},
  page: {defaultLimit: 20, maximumLimit: 50, minimumLimit: 1, overflow: 1, lastIndex: -1, encoding: "base64url", alias: "application_queue", pending: "pending", all: "all"},
  persistence: {rowLock: "update", applicantLock: "ufit-applications:", separator: ":", lockSeed: 0},
  country: /^[A-Z]{2}$/,
  url: {protocols: ["https"], require_protocol: true, require_tld: false},
  failure: {
    active: {code: "application_already_pending", message: "An application is already pending"},
    creatorExists: {code: "application_creator_exists", message: "This account already has a creator profile"},
    notFound: {code: "application_not_found", message: "Application not found"},
    changed: {code: "application_version_changed", message: "The application changed; refresh it before deciding"},
    closed: {code: "application_review_closed", message: "This application is already closed"},
    correction: {code: "application_correction_unavailable", message: "This application cannot be corrected in its current state"},
    reason: {code: "application_reason_required", message: "A message to the applicant is required for this decision"},
    dossier: {code: "application_dossier_incomplete", message: "Additional application information must be provided before acceptance"},
    applicant: {code: "application_applicant_inactive", message: "The applicant account is not active"},
    page: {code: "application_page_invalid", message: "Invalid application page"},
  },
} as const;
export type ApplicationKind = (typeof APPLICATION.kind)[keyof typeof APPLICATION.kind];
export interface CreatorApplicationDossier {instagramUrl: string; tiktokUrl?: string | null; dominantStyle: string; brandsWorn: string; outfitExampleUrls: string[];}
export interface BrandApplicationDossier {instagramUrl: string; country: string; priceRange: string; lookbookUrl: string; shippingCapabilities: string; returnPolicy: string; commissionProposal?: string | null;}
export const APPLICATION_DECISIONS = Object.values(APPLICATION.decision);
export const APPLICATION_ACTIVE_STATUSES = [APPLICATION.status.submitted, APPLICATION.status.underReview, APPLICATION.status.waitlisted, APPLICATION.status.needsMoreInfo] as const;
export const APPLICATION_CORRECTABLE_STATUSES = [APPLICATION.status.rejected, APPLICATION.status.needsMoreInfo] as const;
