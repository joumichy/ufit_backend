import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser } from '../../../modules/identity/domain/user.types';

export interface RequestWithCurrentUser {
  currentUser?: AuthenticatedUser;
  headers: Record<string, string | string[] | undefined>;
  params: Record<string, string | undefined>;
}

export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): AuthenticatedUser => {
  const request = context.switchToHttp().getRequest<RequestWithCurrentUser>();

  if (!request.currentUser) {
    throw new Error('CurrentUser decorator used without AuthGuard');
  }

  return request.currentUser;
});
