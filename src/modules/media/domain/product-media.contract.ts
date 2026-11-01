import {IMAGE_UPLOAD, IMAGE_STORAGE_SETTINGS, MEDIA_ASSET_STATUS, MEDIA_ASSET_STATUSES} from './image-upload.contract';
export const PRODUCT_MEDIA = {
  repository: Symbol('ProductMediaRepository'), storage: Symbol('ProductMediaStorage'), reader: Symbol('ProductMediaReader'), locator: Symbol('ProductMediaLocator'),
  bucket: 'ufit-product-media', mime: IMAGE_UPLOAD.mime, extension: IMAGE_UPLOAD.extension, maxBytes: IMAGE_UPLOAD.maxBytes,
  status: MEDIA_ASSET_STATUS, statuses: MEDIA_ASSET_STATUSES,
  routes: {root: 'media', upload: 'product-uploads', image: 'assets/:id/image', private: 'assets/:id/private', id: 'id', assetPrefix: '/media/assets/', imageSuffix: '/image'},
  multipart: {file: 'file', files: 1, fields: 2},
  hash: IMAGE_UPLOAD.hash,
  image: IMAGE_UPLOAD.image,
  storageSettings: IMAGE_STORAGE_SETTINGS,
  snapshotImageKey: 'imageUrl',
  failure: {
    access: {code: 'media_brand_access_required', message: 'An active membership of a non-suspended brand is required'},
    request: {code: 'media_upload_request_changed', message: 'This upload request was used for different content'},
    file: {code: 'media_image_invalid', message: 'A JPEG image within the upload size limit is required'},
    ownership: {code: 'media_image_unavailable', message: 'The image must be ready and belong to this brand'},
    unavailable: {code: 'media_storage_unavailable', message: 'Image storage is temporarily unavailable'},
    configuration: {code: 'media_configuration_required', message: 'Image storage is not configured'},
    missing: 'Image not found',
  },
} as const;
export type ProductMediaStatus = (typeof PRODUCT_MEDIA.statuses)[number];
