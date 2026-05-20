import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { ReviewApplicationRequest } from '../../src/modules/applications/dto/review-application.request';
import { SubmitBrandApplicationRequest } from '../../src/modules/applications/dto/submit-brand-application.request';
import { SubmitCreatorApplicationRequest } from '../../src/modules/applications/dto/submit-creator-application.request';

describe('application DTO validation', () => {
  it('accepts valid creator applications', async () => {
    const dto = plainToInstance(SubmitCreatorApplicationRequest, {
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
});
