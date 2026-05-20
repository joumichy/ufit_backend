import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_METADATA_KEY } from '../decorators/roles.decorator';
import type { RequestWithCurrentUser } from '../decorators/current-user.decorator';
import type { UserRole } from '../../../modules/identity/domain/user.types';

@Injectable()
export class RoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles =
      this.reflector.getAllAndOverride<UserRole[]>(ROLES_METADATA_KEY, [context.getHandler(), context.getClass()]) ?? [];

    if (requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithCurrentUser>();
    const currentUser = request.currentUser;

    if (!currentUser) {
      throw new UnauthorizedException('Authentication is required');
    }

    if (requiredRoles.some((role) => currentUser.roles.includes(role))) {
      return true;
    }

    throw new ForbiddenException('Insufficient role');
  }
}
