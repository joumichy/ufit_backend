import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from '../src/modules/identity/domain/user.types';
import { ROLES_METADATA_KEY } from '../src/shared/presentation/decorators/roles.decorator';
import { AdminGuard } from '../src/shared/presentation/guards/admin.guard';
import { RoleGuard } from '../src/shared/presentation/guards/role.guard';

const customerUser: AuthenticatedUser = {
  id: '59b6049d-cb0b-4dd2-a6e8-c5728ce8bddd',
  email: 'client@example.com',
  displayName: null,
  avatarUrl: null,
  status: 'active',
  roles: ['customer'],
  createdAt: new Date('2026-05-20T00:00:00.000Z'),
  updatedAt: new Date('2026-05-20T00:00:00.000Z')
};

function createContext(currentUser?: AuthenticatedUser) {
  return {
    getHandler: () => function handler() {},
    getClass: () => class TestController {},
    switchToHttp: () => ({
      getRequest: () => ({
        currentUser
      })
    })
  } as never;
}

describe('RoleGuard', () => {
  it('allows users with one required role', () => {
    const reflector = new Reflector();
    vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) =>
      key === ROLES_METADATA_KEY ? ['customer'] : undefined
    );
    const guard = new RoleGuard(reflector);

    expect(guard.canActivate(createContext(customerUser))).toBe(true);
  });

  it('rejects authenticated users without the required role', () => {
    const reflector = new Reflector();
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['admin']);
    const guard = new RoleGuard(reflector);

    expect(() => guard.canActivate(createContext(customerUser))).toThrow(ForbiddenException);
  });

  it('rejects missing current user when roles are required', () => {
    const reflector = new Reflector();
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['customer']);
    const guard = new RoleGuard(reflector);

    expect(() => guard.canActivate(createContext())).toThrow(UnauthorizedException);
  });
});

describe('AdminGuard', () => {
  it('allows admin users', () => {
    const guard = new AdminGuard();

    expect(
      guard.canActivate(
        createContext({
          ...customerUser,
          roles: ['admin']
        })
      )
    ).toBe(true);
  });

  it('rejects non-admin users', () => {
    const guard = new AdminGuard();

    expect(() => guard.canActivate(createContext(customerUser))).toThrow(ForbiddenException);
  });
});
