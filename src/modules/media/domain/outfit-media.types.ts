import type {ProfileOwner} from '../../../shared/domain/profile-editing.contract';
import type {OutfitMediaStatus} from './outfit-media.contract';
interface OutfitMediaContent {
  id: string; uploadedBy: string; requestId: string; fingerprint: string;
  byteSize: number; contentType: string; objectPath: string;
}
export type OutfitMediaReservation = ProfileOwner & OutfitMediaContent;
export type OutfitMediaAsset = OutfitMediaReservation & {status: OutfitMediaStatus; createdAt: Date; updatedAt: Date};
export type UploadedOutfitImage = ProfileOwner & {id: string; url: string; displayUrl: string};
export interface OutfitMediaRepository {
  reserve(input: OutfitMediaReservation): Promise<OutfitMediaAsset>;
  markReady(asset: OutfitMediaAsset, userId: string): Promise<OutfitMediaAsset>;
  findByIds(ids: string[]): Promise<OutfitMediaAsset[]>;
  findOwnedReady(id: string, userId: string): Promise<OutfitMediaAsset | null>;
  findPublic(id: string, canonicalUrl: string): Promise<OutfitMediaAsset | null>;
}
export interface OutfitMediaSource {owner: ProfileOwner | null; url: string;}
export interface OutfitMediaReader {
  assetIDs(urls: string[]): string[];
  resolveImages(sources: OutfitMediaSource[]): Promise<Map<string, string>>;
}
