import {describe, expect, it} from 'vitest';
import {userAdministrationActions} from '../src/modules/identity/domain/user-administration.policy';
import type {IdentityAccess} from '../src/modules/identity/domain/user.types';
import type {UserAdministrationSubject} from '../src/modules/identity/domain/user-administration.contract';

const admin: IdentityAccess = {status: 'active', roles: ['admin']};
const superAdmin: IdentityAccess = {status: 'active', roles: ['super_admin']};
const user: UserAdministrationSubject = {id: 'subject', status: 'active', roles: ['customer'], version: 1};
const actorId = 'actor';
const noActions = {suspend: false, activate: false, grantAdmin: false, revokeAdmin: false};

describe('user administration permissions', () => {
  it('lets an active administrator suspend and reactivate ordinary accounts', () => {
    expect(userAdministrationActions(actorId,admin,user)).toEqual({...noActions,suspend:true});
    expect(userAdministrationActions(actorId,admin,{...user,status:'suspended'})).toEqual({...noActions,activate:true});
  });
  it('keeps privileged accounts outside an ordinary administrator scope', () => {
    expect(userAdministrationActions(actorId,admin,{...user,roles:['admin']})).toEqual(noActions);
    expect(userAdministrationActions(actorId,admin,{...user,roles:['super_admin']})).toEqual(noActions);
  });
  it('reserves administrator assignment and removal to an active super-administrator', () => {
    expect(userAdministrationActions(actorId,superAdmin,user)).toEqual({...noActions,suspend:true,grantAdmin:true});
    expect(userAdministrationActions(actorId,superAdmin,{...user,roles:['admin']})).toEqual({...noActions,suspend:true,revokeAdmin:true});
  });
  it('does not expose self-suspension or an action changing a super-administrator role', () => {
    expect(userAdministrationActions(user.id,superAdmin,{...user,roles:['super_admin']})).toEqual(noActions);
    expect(userAdministrationActions(actorId,superAdmin,{...user,roles:['super_admin']})).toEqual({...noActions,suspend:true});
  });
  it('never reactivates a deleted account or a suspended administrator authority', () => {
    expect(userAdministrationActions(actorId,superAdmin,{...user,status:'deleted'})).toEqual(noActions);
    expect(userAdministrationActions(actorId,{...admin,status:'suspended'},user)).toEqual(noActions);
    expect(userAdministrationActions(actorId,{status:'active',roles:['customer']},user)).toEqual(noActions);
  });
  it('does not offer another mutation beyond the persistent version range', () => {
    const maximumVersion = 2147483647;
    expect(userAdministrationActions(actorId,superAdmin,{...user,version:maximumVersion})).toEqual(noActions);
  });
});
