import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { RolesGuard } from '../../src/shared/presentation/auth/roles.guard';

function contextWithUser(user: unknown) {
  return {
    getHandler: vi.fn(),
    getClass: vi.fn(),
    switchToHttp: () => ({
      getRequest: () => ({ user })
    })
  };
}

describe('RolesGuard', () => {
  it('allows admins through protected routes', () => {
    const reflector = { getAllAndOverride: vi.fn().mockReturnValue(['admin']) } as unknown as Reflector;
    const guard = new RolesGuard(reflector);

    expect(guard.canActivate(contextWithUser({ id: 'admin-id', roles: ['admin'] }) as never)).toBe(true);
  });

  it('rejects anonymous users on protected routes', () => {
    const reflector = { getAllAndOverride: vi.fn().mockReturnValue(['admin']) } as unknown as Reflector;
    const guard = new RolesGuard(reflector);

    expect(() => guard.canActivate(contextWithUser(undefined) as never)).toThrow(UnauthorizedException);
  });

  it('rejects users without the required role', () => {
    const reflector = { getAllAndOverride: vi.fn().mockReturnValue(['admin']) } as unknown as Reflector;
    const guard = new RolesGuard(reflector);

    expect(() => guard.canActivate(contextWithUser({ id: 'user-id', roles: ['creator'] }) as never)).toThrow(
      ForbiddenException
    );
  });
});
