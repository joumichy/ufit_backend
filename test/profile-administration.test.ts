import {ConflictException, ForbiddenException, NotFoundException} from '@nestjs/common';
import {describe, expect, it, vi} from 'vitest';
import {ProfileAdministrationService} from '../src/modules/identity/application/profile-administration.service';
import {changeProfileStatusSchema, profileAdministrationActions, profileAdministrationPageSchema, type AdministeredProfileState} from '../src/modules/identity/domain/profile-administration.contract';
import type {ProfileAdministrationRepository} from '../src/modules/identity/domain/profile-administration.repository';
import type {IdentityAccess} from '../src/modules/identity/domain/user.types';

const actorId = '3ca3d8c6-c9fe-4bac-881d-4912d1a331a3', userId = '81cfadcd-1bfd-4bdb-9d46-b9f24fc37684', profileId = '5be7aaac-cbde-431c-b735-904f9bcd533b';
const state: AdministeredProfileState = {id: profileId, kind: 'creator', name: 'Atelier', slug: 'atelier', status: 'active', version: 1,
  createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:00.000Z', hasActiveOperator: true};
const proposal = {expectedVersion: 1, status: 'suspended', reason: 'Décision après examen.'};
function subject(options: {actor?: IdentityAccess; profile?: AdministeredProfileState; absent?: boolean; revokedAfterLock?: boolean} = {}) {
  let current = {...(options.profile ?? state)}, locked = false;
  const repository: ProfileAdministrationRepository = {
    transaction: async (_write, operation) => operation(repository),
    findAccess: async () => options.revokedAfterLock && locked ? {status: 'active', roles: ['customer']} : options.actor ?? {status: 'active', roles: ['admin']},
    lockIdentities: vi.fn(async () => {locked = true; return true;}),
    current: vi.fn(async () => options.absent ? undefined : current),
    list: vi.fn(async () => ({items: [current], nextCursor: null})),
    history: vi.fn(async () => ({items: [], nextCursor: null})),
    change: vi.fn(async (_profile, input) => {current = {...current, status: input.status, version: current.version + 1}; return current;}),
  };
  return {repository, service: new ProfileAdministrationService(repository)};
}
describe('profile administration', () => {
  it('requires version, explicit target state and reason without client identities', () => {
    expect(changeProfileStatusSchema.parse(proposal)).toEqual(proposal);
    for (const body of [{...proposal, expectedVersion: 0}, {...proposal, expectedVersion: 1.5}, {...proposal, expectedVersion: 2147483648},
      {...proposal, status: 'draft'}, {...proposal, reason: ' '}, {...proposal, decidedByUserId: userId}, {status: 'active', reason: 'Motif'}]) {
      expect(changeProfileStatusSchema.safeParse(body).success).toBe(false);
    }
    expect(profileAdministrationPageSchema.safeParse({limit: 101}).success).toBe(false);
    expect(profileAdministrationPageSchema.safeParse({status: 'active'}).success).toBe(false);
  });
  it.each(['draft', 'active', 'paused', 'suspended'] as const)('offers only meaningful transitions for %s', status => {
    const actions = profileAdministrationActions({...state, status});
    expect(actions.suspend).toBe(status === 'active' || status === 'paused');
    expect(actions.activate).toBe(status === 'paused' || status === 'suspended');
    expect(actions.pause).toBe(status === 'active' || status === 'suspended');
  });
  it('does not reactivate a profile without an active eligible operator', () => {
    expect(profileAdministrationActions({...state, status: 'suspended', hasActiveOperator: false})).toEqual({suspend: false, activate: false, pause: false});
    expect(profileAdministrationActions({...state, hasActiveOperator: false})).toEqual({suspend: true, activate: false, pause: false});
  });
  it('does not manufacture a transition beyond the maximum version', () => {
    expect(profileAdministrationActions({...state, version: 2147483647})).toEqual({suspend: false, activate: false, pause: false});
  });
  it('returns explicit safe actions without exposing the eligibility implementation', async () => {
    const {service} = subject();
    expect(await service.current(actorId, userId, 'creator', profileId)).toEqual({id: profileId, kind: 'creator', name: state.name, slug: state.slug,
      status: 'active', version: 1, createdAt: state.createdAt, updatedAt: state.updatedAt, actions: {suspend: true, activate: false, pause: true}});
  });
  it.each([{status: 'active', roles: ['customer']}, {status: 'suspended', roles: ['admin']}] as IdentityAccess[])('rereads actual active administration before reads or writes', async actor => {
    const {service, repository} = subject({actor});
    await expect(service.list(actorId, userId, 'creator', {})).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.change(actorId, userId, 'creator', profileId, proposal)).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.change).not.toHaveBeenCalled();
  });
  it('rereads authority after locking before mutation', async () => {
    const {service, repository} = subject({revokedAfterLock: true});
    await expect(service.change(actorId, userId, 'creator', profileId, proposal)).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.change).not.toHaveBeenCalled();
  });
  it('refuses an unrelated profile before mutation or history', async () => {
    const {service, repository} = subject({absent: true});
    await expect(service.change(actorId, userId, 'creator', profileId, proposal)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.history(actorId, userId, 'creator', profileId, {})).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.change).not.toHaveBeenCalled(); expect(repository.history).not.toHaveBeenCalled();
  });
  it('refuses stale decisions including owner pause/resume epochs', async () => {
    const {service, repository} = subject({profile: {...state, version: 3}});
    await expect(service.change(actorId, userId, 'creator', profileId, proposal)).rejects.toBeInstanceOf(ConflictException);
    expect(repository.change).not.toHaveBeenCalled();
  });
  it('suspends and lets administration explicitly choose active or paused on release', async () => {
    const {service, repository} = subject();
    const suspended = await service.change(actorId, userId, 'creator', profileId, proposal);
    expect(suspended.status).toBe('suspended'); expect(suspended.version).toBe(2);
    const paused = await service.change(actorId, userId, 'creator', profileId, {...proposal, expectedVersion: 2, status: 'paused'});
    expect(paused.status).toBe('paused'); expect(paused.version).toBe(3);
    expect(repository.change).toHaveBeenLastCalledWith(expect.objectContaining({id: profileId, status: 'suspended'}), expect.objectContaining({status: 'paused'}), actorId);
  });
});
