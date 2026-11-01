import { z } from 'zod';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import {IMAGE_MEDIA_NAMESPACE, type MediaAssetLocatorConfiguration} from '../domain/image-upload.contract';

export class MediaAssetLocator {
  constructor(private readonly readOrigin: () => string, private readonly configuration: MediaAssetLocatorConfiguration) {}
  private get origin(): string {
    const origin = this.readOrigin();
    try { if (new URL(origin).origin !== origin) throw new Error(); }
    catch { throw new ServiceUnavailableException(this.configuration.failure.configuration); }
    return origin;
  }
  url(id: string): string {
    if (!z.uuid().safeParse(id).success) throw new BadRequestException(this.configuration.failure.ownership);
    return this.origin + this.configuration.routes.assetPrefix + id.toLowerCase() + this.configuration.routes.imageSuffix;
  }
  id(source: string): string | null {
    const url = new URL(source);
    if (url.origin !== this.origin) return null;
    if (!url.pathname.startsWith(this.configuration.routes.assetPrefix)) {
      if (url.pathname.startsWith(IMAGE_MEDIA_NAMESPACE)) throw new BadRequestException(this.configuration.failure.ownership);
      return null;
    }
    const id = url.pathname.slice(this.configuration.routes.assetPrefix.length, -this.configuration.routes.imageSuffix.length);
    if (!z.uuid().safeParse(id).success || source !== this.url(id)) throw new BadRequestException(this.configuration.failure.ownership);
    return id;
  }
}
