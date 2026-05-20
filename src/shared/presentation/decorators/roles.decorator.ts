import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '../../../modules/identity/domain/user.types';

export const ROLES_METADATA_KEY = 'ufit:roles';

export const Roles = (...roles: UserRole[]): MethodDecorator & ClassDecorator => SetMetadata(ROLES_METADATA_KEY, roles);
