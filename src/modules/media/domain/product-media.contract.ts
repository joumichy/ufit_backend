const MEDIA_STATUS = {pending: 'pending', ready: 'ready'} as const;
export const PRODUCT_MEDIA = {
  repository: Symbol('ProductMediaRepository'), storage: Symbol('ProductMediaStorage'), reader: Symbol('ProductMediaReader'), locator: Symbol('ProductMediaLocator'),
  bucket: 'ufit-product-media', mime: 'image/jpeg', extension: '.jpg', maxBytes: 8 * 1024 * 1024,
  status: MEDIA_STATUS, statuses: [MEDIA_STATUS.pending, MEDIA_STATUS.ready],
  routes: {root: 'media', upload: 'product-uploads', image: 'assets/:id/image', id: 'id', assetPrefix: '/media/assets/', imageSuffix: '/image'},
  multipart: {file: 'file', files: 1, fields: 2},
  hash: {algorithm: 'sha256', encoding: 'hex', pattern: '^[a-f0-9]{64}$'},
  image: {prefix: [0xff, 0xd8, 0xff], suffix: [0xff, 0xd9], minimumBytes: 5, firstIndex: 0},
  storageSettings: {signedSeconds: 60, bucketPublic: false, upsert: false, separator: '/', cacheControl: '3600'},
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
