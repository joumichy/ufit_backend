import { UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { IdentityService } from '../src/modules/identity/application/identity.service';
import { IDENTITY_REPOSITORY, type IdentityRepository } from '../src/modules/identity/domain/identity.repository';
import type { AuthenticatedUser } from '../src/modules/identity/domain/user.types';

const activeUser: AuthenticatedUser = {
  id: '59b6049d-cb0b-4dd2-a6e8-c5728ce8bddd',
  email: 'client@example.com',
  displayName: 'Client UFit',
  avatarUrl: null,
  status: 'active',
  roles: ['customer'],
  createdAt: new Date('2026-05-20T00:00:00.000Z'),
  updatedAt: new Date('2026-05-20T00:00:00.000Z')
};

describe('IdentityService', () => {
  it('returns an existing active user from Supabase claims', async () => {
    const repository: Partial<IdentityRepository> = {
      findBySupabaseUserId: vi.fn().mockResolvedValue(activeUser)
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        IdentityService,
        {
          provide: IDENTITY_REPOSITORY,
          useValue: repository
        }
      ]
    }).compile();

    const service = moduleRef.get(IdentityService);

    await expect(service.resolveCurrentUser({ sub: '2ac50e3e-7c11-43d6-bec1-0dcbef8d8997' })).resolves.toEqual(
      activeUser
    );
  });

  it('creates a local user when Supabase claims are valid and unknown', async () => {
    const repository: Partial<IdentityRepository> = {
      findBySupabaseUserId: vi.fn().mockResolvedValue(null),
      createFromSupabaseClaims: vi.fn().mockResolvedValue(activeUser)
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        IdentityService,
        {
          provide: IDENTITY_REPOSITORY,
          useValue: repository
        }
      ]
    }).compile();

    const service = moduleRef.get(IdentityService);

    await expect(
      service.resolveCurrentUser({
        sub: '2ac50e3e-7c11-43d6-bec1-0dcbef8d8997',
        email: 'client@example.com'
      })
    ).resolves.toEqual(activeUser);
    expect(repository.createFromSupabaseClaims).toHaveBeenCalledOnce();
  });

  it('rejects suspended users', async () => {
    const repository: Partial<IdentityRepository> = {
      findBySupabaseUserId: vi.fn().mockResolvedValue({
        ...activeUser,
        status: 'suspended'
      })
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        IdentityService,
        {
          provide: IDENTITY_REPOSITORY,
          useValue: repository
        }
      ]
    }).compile();

    const service = moduleRef.get(IdentityService);

    await expect(service.resolveCurrentUser({ sub: '2ac50e3e-7c11-43d6-bec1-0dcbef8d8997' })).rejects.toBeInstanceOf(
      UnauthorizedException
    );
  });
});
