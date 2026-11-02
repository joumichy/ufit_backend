import type {EditorialCommandKind, EditorialItemType, EditorialFields, EditorialItemsPage, EditorialManagedPage, EditorialPage, EditorialStatus} from './editorial.contract';
export interface EditorialCollection {
  id: string; version: number; title: string; subtitle: string | null; description: string; coverImageUrl: string | null;
  status: EditorialStatus; createdBy: string; publishedAt: Date | null; createdAt: Date; updatedAt: Date;
}
export interface EditorialCollectionItem {
  id: string; collectionId: string; itemType: EditorialItemType; outfitId: string | null; productId: string | null; position: number;
  title: string; imageUrl: string | null; available: boolean;
}
export interface EditorialCollectionDetail {collection: EditorialCollection; items: EditorialCollectionItem[];}
export interface EditorialPublicCollection {
  id: string; version: number; title: string; subtitle: string | null; description: string; coverImageUrl: string | null; itemCount: number;
}
export interface EditorialPublicItem {
  id: string; itemType: EditorialItemType; contentId: string; position: number; title: string; imageUrl: string | null;
}
export interface EditorialReceipt {requestId: string; collectionId: string; version: number; status: EditorialStatus;}
export interface EditorialChangeStatus {receipt: EditorialReceipt | null; current: EditorialCollectionDetail | null;}
export interface EditorialCommand {
  actorId: string; requestId: string; collectionId: string | null; kind: EditorialCommandKind; expectedVersion: number; fields?: EditorialFields;
}
export interface EditorialRepository {
  write(command: EditorialCommand): Promise<EditorialReceipt>;
  change(actorId: string, requestId: string): Promise<EditorialChangeStatus>;
  managed(actorId: string, collectionId: string): Promise<EditorialCollectionDetail>;
  managedPage(actorId: string, input: EditorialManagedPage): Promise<{items: EditorialCollection[]; nextCursor: string | null}>;
  publicPage(input: EditorialPage): Promise<{items: EditorialPublicCollection[]; nextCursor: string | null}>;
  publicDetail(collectionId: string): Promise<EditorialPublicCollection>;
  publicItems(collectionId: string, input: EditorialItemsPage): Promise<{items: EditorialPublicItem[]; nextCursor: string | null}>;
}
export const EDITORIAL_REPOSITORY = Symbol('EDITORIAL_REPOSITORY');
