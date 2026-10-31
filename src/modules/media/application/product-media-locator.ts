import { z } from 'zod';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { PRODUCT_MEDIA } from '../domain/product-media.contract';

export class ProductMediaLocator {
  constructor(private readonly readOrigin: () => string) {}
  private get origin(): string {
    const origin = this.readOrigin();
    try { if (new URL(origin).origin !== origin) throw new Error(); }
    catch { throw new ServiceUnavailableException(PRODUCT_MEDIA.failure.configuration); }
    return origin;
  }
  url(id: string): string {
    if (!z.uuid().safeParse(id).success) throw new BadRequestException(PRODUCT_MEDIA.failure.ownership);
    return this.origin + PRODUCT_MEDIA.routes.assetPrefix + id.toLowerCase() + PRODUCT_MEDIA.routes.imageSuffix;
  }
  id(source: string): string | null {
    const url = new URL(source);
    if (url.origin !== this.origin || !url.pathname.startsWith(PRODUCT_MEDIA.routes.assetPrefix)) return null;
    const id = url.pathname.slice(PRODUCT_MEDIA.routes.assetPrefix.length, -PRODUCT_MEDIA.routes.imageSuffix.length);
    if (!z.uuid().safeParse(id).success || source !== this.url(id)) throw new BadRequestException(PRODUCT_MEDIA.failure.ownership);
    return id;
  }
}
