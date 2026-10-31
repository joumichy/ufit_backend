import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { INestApplication, ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProductMediaController } from '../../src/modules/media/presentation/product-media.controller';
import { ProductMediaService, type ProductImageFile } from '../../src/modules/media/application/product-media.service';
import { PRODUCT_MEDIA } from '../../src/modules/media/domain/product-media.contract';
import { AuthGuard } from '../../src/shared/presentation/guards/auth.guard';
import type { RequestWithCurrentUser } from '../../src/shared/presentation/decorators/current-user.decorator';

const fixture = {
  userId: randomUUID(), brandId: randomUUID(), requestId: randomUUID(), assetId: randomUUID(),
  bytes: Buffer.concat([Buffer.from(PRODUCT_MEDIA.image.prefix), Buffer.from('multipart fixture'), Buffer.from(PRODUCT_MEDIA.image.suffix)]),
  roles: ['brand_owner'], path: '/media/product-uploads', filename: 'photo.jpg', brandField: 'brandId', requestField: 'requestId', actorField: 'uploadedBy',
  origin: 'https://media.test', displayUrl: 'https://signed.test/image.jpg', firstCall: 1, created: 201, badRequest: 400,
  initialCalls: 0, email: 'multipart@example.invalid', status: 'active', timestamp: new Date('2026-10-31T00:00:00.000Z'),
} as const;
describe('Product image multipart transport', () => {
  let app: INestApplication;
  let uploads: number = fixture.initialCalls;
  beforeAll(async () => {
    const module = await Test.createTestingModule({controllers: [ProductMediaController], providers: [{provide: ProductMediaService, useValue: {
      async upload(userId: string, input: {brandId: string; requestId: string}, file: ProductImageFile) {
        assert.equal(userId, fixture.userId); assert.deepEqual(Object.keys(input).sort(), [fixture.brandField, fixture.requestField].sort());
        assert.equal(input.brandId, fixture.brandId); assert.equal(input.requestId, fixture.requestId);
        assert(file.buffer.equals(fixture.bytes)); assert.equal(file.size, fixture.bytes.length); assert.equal(file.mimetype, PRODUCT_MEDIA.mime);
        uploads += fixture.firstCall;
        return {id: fixture.assetId, brandId: fixture.brandId, url: fixture.origin + PRODUCT_MEDIA.routes.assetPrefix + fixture.assetId + PRODUCT_MEDIA.routes.imageSuffix, displayUrl: fixture.displayUrl};
      },
    }}]}).overrideGuard(AuthGuard).useValue({canActivate(context: ExecutionContext) {
      context.switchToHttp().getRequest<RequestWithCurrentUser>().currentUser = {
        id: fixture.userId, email: fixture.email, displayName: null, avatarUrl: null, status: fixture.status,
        roles: [...fixture.roles], createdAt: fixture.timestamp, updatedAt: fixture.timestamp,
      }; return true;
    }}).compile();
    app = module.createNestApplication(); await app.init();
  });
  afterAll(async () => { await app?.close(); });
  it('accepts the two metadata fields plus the image file without rejecting the valid part count', async () => {
    const response = await request(app.getHttpServer()).post(fixture.path)
      .field(fixture.brandField, fixture.brandId).field(fixture.requestField, fixture.requestId)
      .attach(PRODUCT_MEDIA.multipart.file, fixture.bytes, {filename: fixture.filename, contentType: PRODUCT_MEDIA.mime});
    expect(response.status).toBe(fixture.created); expect(response.body.id).toBe(fixture.assetId); expect(uploads).toBe(fixture.firstCall);
  });
  it('rejects a third metadata field before the upload service runs', async () => {
    const before = uploads;
    const response = await request(app.getHttpServer()).post(fixture.path)
      .field(fixture.brandField, fixture.brandId).field(fixture.requestField, fixture.requestId).field(fixture.actorField, fixture.userId)
      .attach(PRODUCT_MEDIA.multipart.file, fixture.bytes, {filename: fixture.filename, contentType: PRODUCT_MEDIA.mime});
    expect(response.status).toBe(fixture.badRequest); expect(uploads).toBe(before);
  });
});
