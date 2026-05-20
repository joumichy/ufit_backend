import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { RequestWithCurrentUser } from '../decorators/current-user.decorator';

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithCurrentUser>();
    const currentUser = request.currentUser;

    if (!currentUser) {
      throw new UnauthorizedException('Authentication is required');
    }

    if (currentUser.roles.includes('admin') || currentUser.roles.includes('super_admin')) {
      return true;
    }

    throw new ForbiddenException('Admin role is required');
  }
}
