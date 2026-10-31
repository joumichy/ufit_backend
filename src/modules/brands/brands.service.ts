import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { BrandApplicationRow, BrandProfileRow } from '../../shared/infrastructure/database/schema';
import type { BrandsRepository } from './brands.repository';
import { BRANDS_REPOSITORY } from './brands.tokens';
import type { UpdateBrandProfileRequest } from './dto/update-brand-profile.request';

function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  return slug || 'brand';
}

@Injectable()
export class BrandsService {
  constructor(@Inject(BRANDS_REPOSITORY) private readonly brandsRepository: BrandsRepository) {}

  async provisionFromApplication(application: BrandApplicationRow): Promise<void> {
    const existing = await this.brandsRepository.findProfileByApplicationId(application.id);
    if (existing) {
      return;
    }

    const profile = await this.brandsRepository.createProfile({
      ownerUserId: application.userId,
      applicationId: application.id,
      brandName: application.brandName,
      slug: `${slugify(application.brandName)}-${application.id.slice(0, 8)}`,
      websiteUrl: application.websiteUrl,
      status: 'active'
    });

    await this.brandsRepository.createOwnerMember({
      brandProfileId: profile.id,
      userId: application.userId,
      role: 'owner',
      status: 'active'
    });
    await this.brandsRepository.createDefaultSettings(profile.id);
  }

  async getPublicProfile(brandProfileId: string) {
    const profile = await this.brandsRepository.findProfileById(brandProfileId);
    if (!profile || profile.status !== 'active') throw new NotFoundException('Public brand not found');
    return { id: profile.id, brandName: profile.brandName, slug: profile.slug, bio: profile.bio, websiteUrl: profile.websiteUrl };
  }

  async getProfileForMember(brandProfileId: string, userId: string): Promise<BrandProfileRow> {
    const profile = await this.brandsRepository.findProfileById(brandProfileId);
    if (!profile) {
      throw new NotFoundException('Brand profile not found');
    }

    const member = await this.brandsRepository.findActiveMember(brandProfileId, userId);
    if (!member) {
      throw new ForbiddenException('Brand membership is required');
    }

    return profile;
  }

  async updateProfileForMember(
    brandProfileId: string,
    userId: string,
    input: UpdateBrandProfileRequest
  ): Promise<BrandProfileRow> {
    const profile = await this.getProfileForMember(brandProfileId, userId);
    if (profile.status === 'suspended') {
      throw new ForbiddenException('Suspended brands cannot be updated');
    }

    return this.brandsRepository.updateProfile(brandProfileId, input);
  }
}
