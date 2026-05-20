export type EditorialCollectionStatus = 'draft' | 'published' | 'archived';
export type EditorialItemType = 'outfit' | 'product';

export interface EditorialCollection {
  id: string;
  title: string;
  subtitle: string | null;
  description: string;
  coverImageUrl: string | null;
  status: EditorialCollectionStatus;
  createdBy: string;
  publishedAt: Date | null;
}

export interface EditorialCollectionItem {
  id: string;
  collectionId: string;
  itemType: EditorialItemType;
  outfitId: string | null;
  productId: string | null;
  position: number;
}

export interface EditorialCollectionDetail {
  collection: EditorialCollection;
  items: EditorialCollectionItem[];
}

export interface EditorialRepository {
  createCollection(input: Omit<EditorialCollection, 'id' | 'status' | 'publishedAt'>): Promise<EditorialCollection>;
  addItems(collectionId: string, items: Array<Omit<EditorialCollectionItem, 'id' | 'collectionId'>>): Promise<EditorialCollectionItem[]>;
  publishCollection(collectionId: string): Promise<EditorialCollection>;
  findPublishedCollections(limit: number): Promise<EditorialCollectionDetail[]>;
}

export const EDITORIAL_REPOSITORY = Symbol('EDITORIAL_REPOSITORY');
