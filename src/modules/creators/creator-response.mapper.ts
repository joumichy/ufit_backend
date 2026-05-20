import type { CreatorProfileRow } from '../../shared/infrastructure/database/schema';

export function mapCreatorProfile(row: CreatorProfileRow): Record<string, unknown> {
  return {
    id: row.id,
    userId: row.userId,
    displayName: row.displayName,
    slug: row.slug,
    bio: row.bio,
    avatarUrl: row.avatarUrl,
    status: row.status,
    gradeCode: row.gradeCode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}
