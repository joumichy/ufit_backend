import type {AuthenticatedUser} from '../../identity/domain/user.types';
import type {ProfileOwner, ProfileOwnerInfo, ProfileKind} from '../../../shared/domain/profile-editing.contract';
import type {OUTFIT_STATUSES, OUTFIT_TAG_TYPES, OUTFIT_VISIBILITIES, OUTFIT_ITEM_TYPES} from './outfit-editing.contract';
import type {GenderTarget} from '../../../shared/domain/gender-target';
export type OutfitStatus = (typeof OUTFIT_STATUSES)[number];
export type OutfitVisibility = (typeof OUTFIT_VISIBILITIES)[number];
export type OutfitItemType = (typeof OUTFIT_ITEM_TYPES)[number];

export interface Outfit {
  id: string;
  version: number;
  creatorId: string | null;
  brandId: string | null;
  title: string;
  description: string;
  coverImageUrl: string;
  status: OutfitStatus;
  visibility: OutfitVisibility;
  genderTarget: GenderTarget | null;
  totalPriceMin: number;
  totalPriceMax: number;
  publishedAt: Date | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  rejectionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OutfitItem {
  id: string;
  outfitId: string;
  productId: string | null;
  externalLabel: string | null;
  itemType: OutfitItemType;
  position: number;
  isRequired: boolean;
  isShoppable: boolean;
  stylingNote: string | null;
}

export interface OutfitImage {
  id: string;
  outfitId: string;
  url: string;
  position: number;
}

export interface OutfitAuthor {
  id: string;
  kind: ProfileKind;
  name: string;
  avatarUrl: string | null;
}

export interface OutfitDetail {
  author: OutfitAuthor | null;
  owner: OutfitOwnerInfo | null;
  tags: OutfitTag[];
  outfit: Outfit;
  items: OutfitItem[];
  images: OutfitImage[];
}

export type OutfitActor = Pick<AuthenticatedUser, 'id' | 'roles'>;
export type OutfitOwner = ProfileOwner;
export type OutfitOwnerInfo = ProfileOwnerInfo;
export interface OutfitTag {id: string; type: (typeof OUTFIT_TAG_TYPES)[number]; slug: string; label: string;}
export interface OutfitManagedPage {items: OutfitDetail[]; nextCursor: string | null;}
export interface OutfitManagedQuery {creatorId?: string; brandId?: string; status?: OutfitStatus; cursor?: string; limit: number;}
export interface OutfitContentUpdate {
  fields: Pick<Outfit, 'title' | 'description' | 'coverImageUrl' | 'genderTarget'>;
  items: Array<Omit<OutfitItem, 'id' | 'outfitId'> & {id?: string}>;
  images: Array<Omit<OutfitImage, 'id' | 'outfitId'> & {id?: string}>;
  tagIds: string[];
}
export interface OutfitRepository {
  transaction<T>(operation: (repository: OutfitRepository) => Promise<T>): Promise<T>;
  readSnapshot<T>(operation: (repository: OutfitRepository) => Promise<T>): Promise<T>;
  findEditableOwner(owner: OutfitOwner, userId: string): Promise<OutfitOwnerInfo | undefined>;
  lockEditableOwner(owner: OutfitOwner, userId: string): Promise<OutfitOwnerInfo | undefined>;
  lockOwner(owner: OutfitOwner): Promise<void>;
  lockOutfit(id: string): Promise<Outfit | undefined>;
  findByCreationRequest(owner: OutfitOwner, requestId: string): Promise<{detail: OutfitDetail; fingerprint: string | null} | null>;
  listManaged(query: OutfitManagedQuery): Promise<OutfitManagedPage>;
  listTags(): Promise<OutfitTag[]>;
  hasReadyOutfitMedia(owner: OutfitOwner, ids: string[]): Promise<boolean>;
  findSelectableProductIds(ids: string[]): Promise<string[]>;
  replaceContent(id: string, input: OutfitContentUpdate): Promise<void>;
  replaceTags(id: string, tagIds: string[]): Promise<void>;
  createOutfit(input: Omit<Outfit, 'id' | 'version' | 'status' | 'visibility' | 'totalPriceMin' | 'totalPriceMax' | 'publishedAt' | 'createdAt' | 'updatedAt'> & {creationRequestId: string; creationFingerprint: string}): Promise<Outfit>;
  addItems(outfitId: string, items: Array<Omit<OutfitItem, 'id' | 'outfitId'>>): Promise<OutfitItem[]>;
  addImages(outfitId: string, images: Array<Omit<OutfitImage, 'id' | 'outfitId'>>): Promise<OutfitImage[]>;
  findById(outfitId: string): Promise<OutfitDetail | null>;
  updateStatus(outfitId: string, status: OutfitStatus, visibility: OutfitVisibility, reviewerId?: string, rejectionReason?: string): Promise<Outfit>;
  updateTotals(outfitId: string, totalPriceMin: number, totalPriceMax: number): Promise<Outfit>;
  findPublishedPage(input: PublicOutfitPage): Promise<OutfitDetail[]>;
}

export const OUTFIT_REPOSITORY = Symbol('OUTFIT_REPOSITORY');
import type {PublicOutfitPage} from './public-outfit.contract';
