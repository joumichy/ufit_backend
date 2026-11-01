import {describe, expect, it} from 'vitest';
import {changeUserAdminAccessSchema, changeUserStatusSchema, userAccessHistoryPageSchema, userAdministrationPageSchema, userAdministrationIdentifierSchema} from '../src/modules/identity/domain/user-administration.contract';

const proposal = {expectedVersion: 1, status: 'suspended', reason: 'Suspension décidée après examen du compte.'};
const access = {expectedVersion: 1, enabled: true, reason: 'Attribution explicite de l’accès administrateur.'};
const invalidVersions = [0, -1, 1.5, 2147483648];
const invalidPageLimits = [0, 101, 1.5];
const malformedCursor = 'not-a-user-id';
const canonicalId = 'a28f6eb2-a851-4617-9c1e-0155091a0ae6';

describe('user administration command contract', () => {
  it('requires an explicit target status, access version and reason', () => {
    expect(changeUserStatusSchema.parse(proposal)).toEqual(proposal);
    for (const expectedVersion of invalidVersions) expect(() => changeUserStatusSchema.parse({...proposal, expectedVersion})).toThrow();
    expect(() => changeUserStatusSchema.parse({...proposal, reason: ' '})).toThrow();
    expect(() => changeUserStatusSchema.parse({status: proposal.status, reason: proposal.reason})).toThrow();
  });
  it('does not expose deletion or arbitrary state changes through moderation', () => {
    expect(() => changeUserStatusSchema.parse({...proposal, status: 'deleted'})).toThrow();
    expect(() => changeUserStatusSchema.parse({...proposal, status: 'onboarding'})).toThrow();
  });
  it('keeps actor and target identity outside command bodies', () => {
    expect(() => changeUserStatusSchema.parse({...proposal, actorId: 'forged'})).toThrow();
    expect(() => changeUserStatusSchema.parse({...proposal, userId: 'another-user'})).toThrow();
    expect(() => changeUserAdminAccessSchema.parse({...access, role: 'super_admin'})).toThrow();
    expect(() => changeUserAdminAccessSchema.parse({...access, roles: ['super_admin']})).toThrow();
  });
  it('requires a boolean for administrator access and preserves false', () => {
    expect(changeUserAdminAccessSchema.parse(access)).toEqual(access);
    expect(changeUserAdminAccessSchema.parse({...access, enabled: false}).enabled).toBe(false);
    expect(() => changeUserAdminAccessSchema.parse({...access, enabled: 'false'})).toThrow();
    expect(() => changeUserAdminAccessSchema.parse({...access, enabled: undefined})).toThrow();
  });
  it('uses the existing identity states and roles for list filters', () => {
    expect(userAdministrationPageSchema.parse({status: 'suspended', role: 'creator', search: ' Studio ', limit: '1'}))
      .toEqual({status: 'suspended', role: 'creator', search: 'Studio', limit: 1});
    expect(() => userAdministrationPageSchema.parse({role: 'owner'})).toThrow();
    expect(() => userAdministrationPageSchema.parse({status: 'enabled'})).toThrow();
  });
  it('bounds pagination and requires canonical identifier cursors', () => {
    expect(userAdministrationIdentifierSchema.parse(canonicalId.toUpperCase())).toBe(canonicalId);
    expect(userAccessHistoryPageSchema.parse({cursor: canonicalId.toUpperCase()}).cursor).toBe(canonicalId);
    expect(() => userAccessHistoryPageSchema.parse({cursor: malformedCursor})).toThrow();
    expect(() => userAdministrationPageSchema.parse({cursor: malformedCursor})).toThrow();
    for (const limit of invalidPageLimits) expect(() => userAdministrationPageSchema.parse({limit})).toThrow();
  });
});
