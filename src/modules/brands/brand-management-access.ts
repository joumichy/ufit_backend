import {ForbiddenException} from '@nestjs/common';
import type {BrandManagementAccess} from './brands.repository';
import {PROFILE_EDITING, canAuthorProfile} from '../../shared/domain/profile-editing.contract';
import {PUBLIC_PROFILE} from '../../shared/domain/public-profile.contract';

export const BRAND_MANAGEMENT = {
  adminRoles: ['admin', 'super_admin'] as const,
  failure: {code: 'brand_management_access_required', message: 'Access to this brand is required'},
};
export function requireBrandManagementAccess(context: BrandManagementAccess | undefined, failure: {code: string; message: string} = BRAND_MANAGEMENT.failure): asserts context is BrandManagementAccess {
  if (!context || context.actor.status !== PUBLIC_PROFILE.userStatus || !PROFILE_EDITING.writableStatuses.some(status => status === context.brand.status)) {
    throw new ForbiddenException(failure);
  }
  const administrator = BRAND_MANAGEMENT.adminRoles.some(role => context.actor.roles.includes(role));
  const member = context.memberRole !== null && canAuthorProfile(context.actor.roles, {brandId: context.brand.id, creatorId: null});
  if (!administrator && !member) throw new ForbiddenException(failure);
}
