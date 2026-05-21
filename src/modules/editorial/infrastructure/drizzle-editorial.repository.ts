import { Inject, Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DatabaseService } from '../../../shared/infrastructure/database/database.service';
import { editorialCollectionItems, editorialCollections } from '../../../shared/infrastructure/database/schema';
import type { EditorialCollection, EditorialCollectionDetail, EditorialCollectionItem, EditorialRepository } from '../domain/editorial.types';

@Injectable()
export class DrizzleEditorialRepository implements EditorialRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async createCollection(input: Parameters<EditorialRepository['createCollection']>[0]): Promise<EditorialCollection> {
    const [row] = await this.database.db.insert(editorialCollections).values({ ...input, status: 'draft', publishedAt: null }).returning();
    return row;
  }

  async addItems(collectionId: string, items: Parameters<EditorialRepository['addItems']>[1]): Promise<EditorialCollectionItem[]> {
    if (!items.length) {
      return [];
    }
    return this.database.db.insert(editorialCollectionItems).values(items.map((item) => ({ ...item, collectionId }))).returning();
  }

  async publishCollection(collectionId: string): Promise<EditorialCollection> {
    const [row] = await this.database.db
      .update(editorialCollections)
      .set({ status: 'published', publishedAt: new Date(), updatedAt: new Date() })
      .where(eq(editorialCollections.id, collectionId))
      .returning();
    return row;
  }

  async findPublishedCollections(limit: number): Promise<EditorialCollectionDetail[]> {
    const rows = await this.database.db
      .select()
      .from(editorialCollections)
      .where(eq(editorialCollections.status, 'published'))
      .orderBy(desc(editorialCollections.publishedAt))
      .limit(limit);
    const details = await Promise.all(
      rows.map(async (collection) => ({
        collection,
        items: await this.database.db
          .select()
          .from(editorialCollectionItems)
          .where(eq(editorialCollectionItems.collectionId, collection.id))
      }))
    );
    return details;
  }
}
