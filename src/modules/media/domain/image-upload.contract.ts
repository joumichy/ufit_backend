export const MEDIA_ASSET_STATUS = {pending: 'pending', ready: 'ready'} as const;
export const MEDIA_ASSET_STATUSES = [MEDIA_ASSET_STATUS.pending, MEDIA_ASSET_STATUS.ready] as const;
export const IMAGE_UPLOAD = {
  mime: 'image/jpeg', extension: '.jpg', maxBytes: 8 * 1024 * 1024,
  hash: {algorithm: 'sha256', encoding: 'hex', pattern: '^[a-f0-9]{64}$'},
  image: {prefix: [0xff, 0xd8, 0xff], suffix: [0xff, 0xd9], minimumBytes: 5, firstIndex: 0},
} as const;
export const IMAGE_STORAGE_SETTINGS = {signedSeconds: 60, bucketPublic: false, upsert: false, separator: '/', cacheControl: '3600'} as const;
export const IMAGE_ERASURE = {bytes: 0, upsert: true, cacheControl: '0'} as const;
export const IMAGE_MEDIA_NAMESPACE = '/media/';
export interface ImageUploadFile {buffer: Buffer; mimetype: string; size: number;}
export interface ImageMediaFailure {code: string; message: string;}
export interface ImageStorage {
  uploadOrVerify(path: string, bytes: Buffer, fingerprint: string): Promise<void>;
  sign(paths: string[]): Promise<Map<string, string>>;
}
export interface ImageErasureStorage {eraseOrVerify(path: string): Promise<void>;}
export interface ImageStorageConfiguration {
  bucket: string; mime: string; hash: {algorithm: string; encoding: 'hex'};
  storageSettings: {signedSeconds: number; upsert: boolean; cacheControl: string};
  failure: {configuration: ImageMediaFailure; unavailable: ImageMediaFailure};
}
export interface MediaAssetLocatorConfiguration {
  routes: {assetPrefix: string; imageSuffix: string};
  failure: {configuration: ImageMediaFailure; ownership: ImageMediaFailure};
}
