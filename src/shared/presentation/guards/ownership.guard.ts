import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { RequestWithCurrentUser } from '../decorators/current-user.decorator';

@Injectable()
export class OwnershipGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithCurrentUser>();
    const currentUser = request.currentUser;

    if (!currentUser) {
      throw new UnauthorizedException('Authentication is required');
    }

    const targetUserId = request.params.userId ?? request.params.id;
    const isAdmin = currentUser.roles.includes('admin') || currentUser.roles.includes('super_admin');

    if (isAdmin || !targetUserId || targetUserId === currentUser.id) {
      return true;
    }

    throw new ForbiddenException('Resource ownership is required');
  }
}
