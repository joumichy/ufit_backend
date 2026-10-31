import { APPLICATION_COUNTRIES } from "../../src/modules/applications/application-countries";
import "reflect-metadata";
import {creatorDossier, brandDossier} from "./application-fixtures";
import { plainToInstance } from 'class-transformer';
import { isISO31661Alpha2, validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { ReviewApplicationRequest } from '../../src/modules/applications/dto/review-application.request';
import { SubmitBrandApplicationRequest } from '../../src/modules/applications/dto/submit-brand-application.request';
import { SubmitCreatorApplicationRequest } from '../../src/modules/applications/dto/submit-creator-application.request';

describe('application DTO validation', () => {
  it('offers unique ISO countries accepted by the dossier validator', () => {
    expect(APPLICATION_COUNTRIES).toContain('CH');
    expect(APPLICATION_COUNTRIES).not.toContain('XK');
    expect(new Set(APPLICATION_COUNTRIES).size).toBe(APPLICATION_COUNTRIES.length);
    expect(APPLICATION_COUNTRIES.every(country => /^[A-Z]{2}$/.test(country) && isISO31661Alpha2(country))).toBe(true);
  });
  it('accepts valid creator applications', async () => {
    const dto = plainToInstance(SubmitCreatorApplicationRequest, {
      dossier: creatorDossier,
      displayName: 'Mira Studio',
      email: 'mira@example.com',
      portfolioUrl: 'https://example.com/mira',
      motivation: 'I curate sharp outfits for independent labels.'
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('rejects incomplete brand applications', async () => {
    const dto = plainToInstance(SubmitBrandApplicationRequest, {
      brandName: 'N',
      email: 'not-an-email',
      websiteUrl: 'not a url',
      productCategory: '',
      positioning: 'short'
    });

    const errors = await validate(dto);

    expect(errors.map((error) => error.property)).toEqual(
      expect.arrayContaining(['brandName', 'email', 'websiteUrl', 'productCategory', 'positioning'])
    );
  });

  it('rejects unknown admin review decisions', async () => {
    const dto = plainToInstance(ReviewApplicationRequest, {
      decision: 'approve_anyway'
    });

    await expect(validate(dto)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ property: 'decision' })])
    );
  });
  it('accepts a creator without an optional portfolio and rejects an incomplete outfit dossier', async () => {
    const fields = {displayName: 'Mira Studio', email: 'mira@example.test', motivation: 'Une candidature complète pour présenter des tenues originales.', dossier: creatorDossier};
    expect(await validate(plainToInstance(SubmitCreatorApplicationRequest, fields))).toHaveLength(0);
    const invalid = plainToInstance(SubmitCreatorApplicationRequest, {...fields, dossier: {...creatorDossier, outfitExampleUrls: creatorDossier.outfitExampleUrls.slice(0, 2)}});
    expect(await validate(invalid)).toEqual(expect.arrayContaining([expect.objectContaining({property: 'dossier'})]));
  });
  it('rejects missing review versions and fields that would choose another applicant', async () => {
    const review = plainToInstance(ReviewApplicationRequest, {decision: 'accept'});
    expect(await validate(review)).toEqual(expect.arrayContaining([expect.objectContaining({property: 'expectedVersion'})]));
    const candidate = plainToInstance(SubmitBrandApplicationRequest, {brandName: 'Maison de qualification', email: 'brand@example.test', websiteUrl: 'https://example.test', productCategory: 'Vêtements', positioning: 'Marque indépendante destinée à la qualification métier.', dossier: brandDossier, userId: 'another-user'});
    expect(await validate(candidate, {whitelist: true, forbidNonWhitelisted: true})).toEqual(expect.arrayContaining([expect.objectContaining({property: 'userId'})]));
  });

  it('requires a dossier object and rejects nested actor fields', async () => {
    const fields = {displayName: 'Mira Studio', email: 'mira@example.test', motivation: 'Une candidature complète pour présenter des tenues originales.'};
    for (const dossier of [[], null, 'invalid']) {
      expect(await validate(plainToInstance(SubmitCreatorApplicationRequest, {...fields, dossier}))).toEqual(expect.arrayContaining([expect.objectContaining({property: 'dossier'})]));
    }
    const nestedActor = plainToInstance(SubmitCreatorApplicationRequest, {...fields, dossier: {...creatorDossier, userId: 'another-user'}});
    expect(await validate(nestedActor, {whitelist: true, forbidNonWhitelisted: true})).toEqual(expect.arrayContaining([expect.objectContaining({property: 'dossier'})]));
  });
});
