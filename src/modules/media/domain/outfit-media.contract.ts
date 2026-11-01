import {IMAGE_UPLOAD, IMAGE_STORAGE_SETTINGS, MEDIA_ASSET_STATUS, MEDIA_ASSET_STATUSES} from './image-upload.contract';

export const OUTFIT_MEDIA = {
  repository: Symbol('OutfitMediaRepository'), storage: Symbol('OutfitMediaStorage'), reader: Symbol('OutfitMediaReader'), locator: Symbol('OutfitMediaLocator'),
  bucket: 'ufit-outfit-media', mime: IMAGE_UPLOAD.mime, extension: IMAGE_UPLOAD.extension, maxBytes: IMAGE_UPLOAD.maxBytes,
  status: MEDIA_ASSET_STATUS, statuses: MEDIA_ASSET_STATUSES, hash: IMAGE_UPLOAD.hash, storageSettings: IMAGE_STORAGE_SETTINGS,
  routes: {root: 'media', upload: 'outfit-uploads', image: 'outfit-assets/:id/image', private: 'outfit-assets/:id/private', id: 'id', assetPrefix: '/media/outfit-assets/', imageSuffix: '/image'},
  multipart: {file: 'file', files: 1, fields: 3},
  failure: {
    owner: {code: 'media_outfit_owner_required', message: 'Exactly one creator or brand owner is required'},
    access: {code: 'media_outfit_access_required', message: 'An active authoring membership is required'},
    request: {code: 'media_outfit_upload_request_changed', message: 'This upload request was used for different content'},
    file: {code: 'media_outfit_image_invalid', message: 'A JPEG image within the upload size limit is required'},
    ownership: {code: 'media_outfit_image_unavailable', message: 'The image must be ready and belong to this outfit author'},
    unavailable: {code: 'media_outfit_storage_unavailable', message: 'Image storage is temporarily unavailable'},
    configuration: {code: 'media_outfit_configuration_required', message: 'Image storage is not configured'},
    missing: 'Outfit image not found',
  },
} as const;
export type OutfitMediaStatus = (typeof OUTFIT_MEDIA.statuses)[number];
