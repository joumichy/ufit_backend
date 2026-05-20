import type { BrandProfileRow } from '../../shared/infrastructure/database/schema';

export function mapBrandProfile(row: BrandProfileRow): Record<string, unknown> {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    brandName: row.brandName,
    slug: row.slug,
    websiteUrl: row.websiteUrl,
    bio: row.bio,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}
