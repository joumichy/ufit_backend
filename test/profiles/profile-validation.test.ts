import 'reflect-metadata';
import {plainToInstance} from 'class-transformer';
import {validate} from 'class-validator';
import {describe, expect, it} from 'vitest';
import {UpdateCreatorProfileRequest} from '../../src/modules/creators/dto/update-creator-profile.request';
import {UpdateBrandProfileRequest} from '../../src/modules/brands/dto/update-brand-profile.request';
const social = {platform: 'instagram', handle: '@camille', url: 'https://example.test/camille'};
const options = {whitelist: true, forbidNonWhitelisted: true};
describe('owned profile editing contracts', () => {
  it('normalizes an explicitly cleared nullable field while preserving an omitted field', async () => {
    const brand = plainToInstance(UpdateBrandProfileRequest, {bio: '  ', websiteUrl: null});
    expect(await validate(brand, options)).toHaveLength(0);
    expect(brand.bio).toBeNull(); expect(brand.websiteUrl).toBeNull(); expect(brand.brandName).toBeUndefined();
  });
  it('rejects null names and privileged statuses', async () => {
    for (const input of [{displayName: null}, {status: 'suspended'}, {status: null}]) {
      expect((await validate(plainToInstance(UpdateCreatorProfileRequest, input), options)).length).toBeGreaterThan(0);
    }
    expect((await validate(plainToInstance(UpdateBrandProfileRequest, {brandName: null}), options)).length).toBeGreaterThan(0);
  });
  it('requires unique social platforms and real account objects', async () => {
    expect(await validate(plainToInstance(UpdateCreatorProfileRequest, {socialAccounts: [social]}), options)).toHaveLength(0);
    for (const socialAccounts of [[social, social], [null], null, [{...social, platform: 'unsupported'}]]) {
      expect((await validate(plainToInstance(UpdateCreatorProfileRequest, {socialAccounts}), options)).length).toBeGreaterThan(0);
    }
  });
  it('rejects forged ownership and non-web social links', async () => {
    for (const input of [{userId: 'forged'}, {socialAccounts: [{...social, url: 'ftp://example.test/profile'}]}]) {
      expect((await validate(plainToInstance(UpdateCreatorProfileRequest, input), options)).length).toBeGreaterThan(0);
    }
  });
});
