export type OutfitStatus = 'draft' | 'submitted' | 'under_review' | 'published' | 'rejected' | 'archived';
export type OutfitVisibility = 'public' | 'private' | 'featured';
export type OutfitItemType = 'top' | 'bottom' | 'shoes' | 'bag' | 'accessory' | 'outerwear';

export interface Outfit {
  id: string;
  creatorId: string | null;
  brandId: string | null;
  title: string;
  description: string;
  coverImageUrl: string;
  status: OutfitStatus;
  visibility: OutfitVisibility;
  genderTarget: 'male' | 'female' | 'unisex' | null;
  totalPriceMin: number;
  totalPriceMax: number;
  publishedAt: Date | null;
  reviewedBy?: string | null;
  reviewedAt?: Date | null;
  rejectionReason?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
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

export interface OutfitDetail {
  outfit: Outfit;
  items: OutfitItem[];
  images: OutfitImage[];
}

export interface OutfitRepository {
  createOutfit(input: Omit<Outfit, 'id' | 'status' | 'visibility' | 'totalPriceMin' | 'totalPriceMax' | 'publishedAt' | 'createdAt' | 'updatedAt'>): Promise<Outfit>;
  addItems(outfitId: string, items: Array<Omit<OutfitItem, 'id' | 'outfitId'>>): Promise<OutfitItem[]>;
  addImages(outfitId: string, images: Array<Omit<OutfitImage, 'id' | 'outfitId'>>): Promise<OutfitImage[]>;
  findById(outfitId: string): Promise<OutfitDetail | null>;
  updateStatus(outfitId: string, status: OutfitStatus, visibility: OutfitVisibility, reviewerId?: string, rejectionReason?: string): Promise<Outfit>;
  updateTotals(outfitId: string, totalPriceMin: number, totalPriceMax: number): Promise<Outfit>;
  findPublishedPage(input: { limit: number; cursor?: string }): Promise<OutfitDetail[]>;
}

export const OUTFIT_REPOSITORY = Symbol('OUTFIT_REPOSITORY');
