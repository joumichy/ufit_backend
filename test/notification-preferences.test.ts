import 'reflect-metadata';
import {describe,expect,it,vi} from 'vitest';
import {HttpException} from '@nestjs/common';
import type {AuthenticatedUser} from '../src/modules/identity/domain/user.types';
import {notificationPreferencesInputSchema,notificationPreferencesSchema} from '../src/modules/notifications/domain/notification-preferences';
import {NotificationsController} from '../src/modules/notifications/presentation/notifications.controller';
import {DrizzleNotificationReader} from '../src/modules/notifications/infrastructure/drizzle-notification-reader';
import {DrizzleNotificationPreferencesRepository} from '../src/modules/notifications/infrastructure/drizzle-notification-preferences.repository';

const FIXTURE={userId:'8de392a4-9161-4000-a927-57b826ce9d9a',otherId:'8de392a4-9161-4000-a927-57b826ce9d9b',
  time:'2026-11-02T00:00:00.000Z',initial:0,persisted:1,maximum:2147483647,
  defaults:{emailEnabled:true,pushEnabled:true},input:{expectedVersion:0,emailEnabled:false,pushEnabled:true}} as const;
function actor():AuthenticatedUser {
  return {id:FIXTURE.userId,email:'qualification@example.invalid',displayName:null,avatarUrl:null,status:'active',roles:['customer'],createdAt:new Date(FIXTURE.time),updatedAt:new Date(FIXTURE.time)};
}
function controller(){
  const preferences={read:vi.fn(),write:vi.fn()},reader={read:vi.fn()};
  return {preferences,reader,controller:new NotificationsController(reader as unknown as DrizzleNotificationReader,preferences as unknown as DrizzleNotificationPreferencesRepository)};
}
describe('Notification preference boundary',()=>{
  it('represents an absent row as explicit defaults with no fabricated timestamp',()=>{
    const value={userId:FIXTURE.userId,version:FIXTURE.initial,...FIXTURE.defaults,updatedAt:null};
    expect(notificationPreferencesSchema.parse(value)).toEqual(value);
  });
  it('represents a persisted revision including its server timestamp',()=>{
    const value={userId:FIXTURE.userId,version:FIXTURE.persisted,emailEnabled:false,pushEnabled:true,updatedAt:FIXTURE.time};
    expect(notificationPreferencesSchema.parse(value)).toEqual(value);
  });
  it.each([
    {version:0,emailEnabled:false,pushEnabled:true,updatedAt:null},
    {version:0,emailEnabled:true,pushEnabled:true,updatedAt:FIXTURE.time},
    {version:1,emailEnabled:true,pushEnabled:true,updatedAt:null},
    {version:1,emailEnabled:true,pushEnabled:true,updatedAt:'yesterday'},
  ])('rejects contradictory presence/timestamp semantics: %j',state=>{
    expect(notificationPreferencesSchema.safeParse({userId:FIXTURE.userId,...state}).success).toBe(false);
  });
  it.each([
    {emailEnabled:true,pushEnabled:true},
    {expectedVersion:-1,emailEnabled:true,pushEnabled:true},
    {expectedVersion:0.5,emailEnabled:true,pushEnabled:true},
    {expectedVersion:'0',emailEnabled:true,pushEnabled:true},
    {expectedVersion:FIXTURE.maximum,emailEnabled:true,pushEnabled:true},
    {expectedVersion:0,emailEnabled:'false',pushEnabled:true},
    {expectedVersion:0,emailEnabled:false,pushEnabled:null},
    {...FIXTURE.input,userId:FIXTURE.otherId},
    {...FIXTURE.input,version:1},
  ])('rejects malformed or conflicting write contracts: %j',input=>{
    expect(notificationPreferencesInputSchema.safeParse(input).success).toBe(false);
  });
  it('accepts one exact versioned choice without an actor supplied in the body',()=>{
    expect(notificationPreferencesInputSchema.parse(FIXTURE.input)).toEqual(FIXTURE.input);
  });
});
describe('Notification preferences stay bound to the requested account',()=>{
  it.each(['readPreferences','writePreferences'] as const)('does not rebind a stale request to another authenticated actor: %s',method=>{
    const subject=controller();
    try {subject.controller[method](actor(),FIXTURE.otherId,FIXTURE.input);throw new Error('Expected account rejection');}
    catch(error){expect(error).toBeInstanceOf(HttpException);expect((error as HttpException).getStatus()).toBe(404);}
    expect(subject.preferences.read).not.toHaveBeenCalled();expect(subject.preferences.write).not.toHaveBeenCalled();
  });
  it('reads the authenticated business account after canonical UUID normalization',()=>{
    const subject=controller();subject.controller.readPreferences(actor(),FIXTURE.userId.toUpperCase());
    expect(subject.preferences.read).toHaveBeenCalledExactlyOnceWith(FIXTURE.userId);
  });
  it('writes only the bound authenticated account with the unchanged input',()=>{
    const subject=controller();subject.controller.writePreferences(actor(),FIXTURE.userId.toUpperCase(),FIXTURE.input);
    expect(subject.preferences.write).toHaveBeenCalledExactlyOnceWith(FIXTURE.userId,FIXTURE.input);
  });
});
