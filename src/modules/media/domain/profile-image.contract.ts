import {z} from 'zod';
import {IMAGE_UPLOAD, IMAGE_STORAGE_SETTINGS, MEDIA_ASSET_STATUS} from './image-upload.contract';
export const PROFILE_IMAGE = {
  token: {storage: Symbol('ProfileImageStorage'), locator: Symbol('ProfileImageLocator')},
  kind: {account: 'account', creator: 'creator', brand: 'brand'},
  bucket: 'ufit-profile-media', mime: IMAGE_UPLOAD.mime, extension: IMAGE_UPLOAD.extension, maxBytes: IMAGE_UPLOAD.maxBytes,
  hash: IMAGE_UPLOAD.hash, storageSettings: IMAGE_STORAGE_SETTINGS, status: MEDIA_ASSET_STATUS,
  routes: {root: 'media', upload: 'profile-uploads', selection: 'profile-images/:kind/:ownerId',
    image: 'profile-assets/:id/image', private: 'profile-assets/:id/private', assetPrefix: '/media/profile-assets/', imageSuffix: '/image',
    id: 'id', kind: 'kind', ownerId: 'ownerId'},
  multipart: {file: 'file', files: 1, fields: 3},
  limits: {zero: 0, one: 1, initialVersion: 0, maxVersion: 2_147_483_647},
  access: {lock: 'update', member: 'active'},
  failure: {
    invalid: {code: 'profile_image_invalid', message: 'Invalid profile image command'},
    access: {code: 'profile_image_access_required', message: 'An active profile owner is required'},
    request: {code: 'profile_image_request_changed', message: 'This request was used for different content'},
    changed: {code: 'profile_image_version_changed', message: 'The profile image changed; refresh before saving'},
    file: {code: 'profile_image_file_invalid', message: 'A JPEG image within the upload size limit is required'},
    ownership: {code: 'profile_image_unavailable', message: 'The image must be ready and belong to this profile'},
    unavailable: {code: 'profile_image_storage_unavailable', message: 'Image storage is temporarily unavailable'},
    configuration: {code: 'profile_image_configuration_required', message: 'Image storage is not configured'},
    missing: 'Profile image not found',
  },
} as const;
export const profileImageKind = z.enum(Object.values(PROFILE_IMAGE.kind));
const identifier = z.uuid().transform(value=>value.toLowerCase());
export const profileImageOwner = z.object({kind: profileImageKind, ownerId: identifier}).strict();
export const profileImageUpload = profileImageOwner.extend({requestId: identifier}).strict();
export const profileImageSelection = z.object({requestId: identifier,
  expectedVersion: z.number().int().min(PROFILE_IMAGE.limits.initialVersion).max(PROFILE_IMAGE.limits.maxVersion-PROFILE_IMAGE.limits.one),
  assetId: identifier.nullable()}).strict();
export type ProfileImageOwner = z.infer<typeof profileImageOwner>;
export type ProfileImageSelection = z.infer<typeof profileImageSelection>;
export interface ProfileImageState {version: number; url: string | null;}
