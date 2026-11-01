import {createHash} from 'node:crypto';
import {BadRequestException} from '@nestjs/common';
import {IMAGE_UPLOAD, type ImageUploadFile, type ImageMediaFailure} from '../domain/image-upload.contract';

export function prepareImageUpload(file: ImageUploadFile | undefined, failure: ImageMediaFailure): {bytes: Buffer; fingerprint: string} {
  const image = IMAGE_UPLOAD.image;
  if (!file || file.mimetype !== IMAGE_UPLOAD.mime || file.size !== file.buffer.length || file.buffer.length < image.minimumBytes || file.buffer.length > IMAGE_UPLOAD.maxBytes ||
      !file.buffer.subarray(image.firstIndex, image.prefix.length).equals(Buffer.from(image.prefix)) ||
      !file.buffer.subarray(-image.suffix.length).equals(Buffer.from(image.suffix))) throw new BadRequestException(failure);
  return {bytes: file.buffer, fingerprint: createHash(IMAGE_UPLOAD.hash.algorithm).update(file.buffer).digest(IMAGE_UPLOAD.hash.encoding)};
}
