import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

export interface RequestUser {
  id: string;
  roles: string[];
}

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): RequestUser | undefined => {
  const request = ctx.switchToHttp().getRequest<{ user?: RequestUser }>();
  return request.user;
});
