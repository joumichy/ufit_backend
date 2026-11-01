import {createHash} from 'node:crypto';
import {ServiceUnavailableException} from '@nestjs/common';
import {IMAGE_UPLOAD, type ImageMediaFailure, type ImageStorage} from '../../src/modules/media/domain/image-upload.contract';
export const imageStorageFixture = {signed: 'https://signed.test/', zero: 0, callStep: 1, invalid: 'Invalid image storage fixture contract'} as const;
export class MemoryImageStorage implements ImageStorage {
  readonly files = new Map<string, Buffer>();
  uploadCalls = imageStorageFixture.zero;
  failUpload = false;
  omitSignedPath = false;
  afterUpload?: () => void;
  constructor(private readonly unavailable: ImageMediaFailure) {}
  async uploadOrVerify(path: string, bytes: Buffer, fingerprint: string) {
    if (createHash(IMAGE_UPLOAD.hash.algorithm).update(bytes).digest(IMAGE_UPLOAD.hash.encoding) !== fingerprint) throw new Error(imageStorageFixture.invalid);
    this.uploadCalls += imageStorageFixture.callStep;
    if (this.failUpload) throw new ServiceUnavailableException(this.unavailable);
    const previous = this.files.get(path);
    if (previous && !previous.equals(bytes)) throw new Error(imageStorageFixture.invalid);
    this.files.set(path, bytes); this.afterUpload?.();
  }
  async sign(paths: string[]) {
    if (paths.some(path => !this.files.has(path))) throw new ServiceUnavailableException(this.unavailable);
    return this.omitSignedPath ? new Map<string, string>() : new Map(paths.map(path => [path, imageStorageFixture.signed + path]));
  }
}
