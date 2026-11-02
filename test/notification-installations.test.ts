import 'reflect-metadata';
import {describe,expect,it,vi} from 'vitest';
import {HttpException} from '@nestjs/common';
import type {AuthenticatedUser} from '../src/modules/identity/domain/user.types';
import {INSTALLATION as I,installationDocumentSchema,installationRegistrationSchema,installationProofSchema,installationDetachedSchema} from '../src/modules/notifications/domain/notification-installation';
import {NotificationInstallationsController} from '../src/modules/notifications/presentation/notification-installations.controller';
import {DrizzleNotificationInstallationsRepository} from '../src/modules/notifications/infrastructure/drizzle-notification-installations.repository';

const F={installationId:'ace23b82-8895-4cb1-bf28-e4454432a23c',userId:'ada40c9c-d2dd-4a65-8fe7-0705146f9092',otherUserId:'ada40c9c-d2dd-4a65-8fe7-0705146f9093',
  associationId:'89cc9d25-2d1a-41b5-86e2-e07143cb8dd4',registrationId:'f48ec8ef-37d1-4bc3-80c0-f67958039066',
  date:'2026-11-02T00:00:00.000Z',secretPair:'ab',secretBytes:32,token:'00abcdef',environment:'development',
  version:{absent:0,persisted:1,negative:-1,fraction:0.5,string:'0',maximum:2_147_483_647},
  user:{email:'qualification@example.invalid',status:'active',role:'customer'},empty:'',odd:'abc',upper:'AB',invalidTime:'today',secretPrefix:'Bearer ',foreignStatus:404,
} as const;
const secret=F.secretPair.repeat(F.secretBytes);
const input={expectedVersion:F.version.absent,associationId:F.associationId,registrationId:F.registrationId,deviceToken:F.token,environment:F.environment};
const absent={installationId:F.installationId,version:F.version.absent,state:I.state.unregistered,associationId:null,registrationId:null,environment:null,registeredAt:null,isCurrentAccount:false,updatedAt:null};
const registered={installationId:F.installationId,version:F.version.persisted,state:I.state.registered,associationId:F.associationId,registrationId:F.registrationId,
  environment:F.environment,registeredAt:F.date,isCurrentAccount:true,updatedAt:F.date};
function actor():AuthenticatedUser {return {id:F.userId,email:F.user.email,status:F.user.status,roles:[F.user.role],displayName:null,avatarUrl:null,createdAt:new Date(F.date),updatedAt:new Date(F.date)};}
describe('Notification installation canonical contracts',()=>{
  it('represents a virtual installation without inventing a token, account or timestamp',()=>expect(installationDocumentSchema.parse(absent)).toEqual(absent));
  it('represents a real current registration without exposing its proof or token',()=>expect(installationDocumentSchema.parse(registered)).toEqual(registered));
  it('represents an installation bound to another account with no identity disclosure',()=>{
    expect(installationDocumentSchema.parse({...registered,isCurrentAccount:false}).isCurrentAccount).toBe(false);
    expect(installationDocumentSchema.safeParse({...registered,userId:F.otherUserId}).success).toBe(false);
  });
  it('represents a known detached installation with no remaining binding fields',()=>{
    expect(installationDocumentSchema.parse({...absent,version:F.version.persisted,state:I.state.detached,updatedAt:F.date}).state).toBe(I.state.detached);
  });
  it.each([
    {...absent,updatedAt:F.date},{...absent,version:F.version.persisted},{...absent,isCurrentAccount:true},
    {...registered,registeredAt:null},{...registered,updatedAt:null},{...registered,state:I.state.detached},
    {...registered,registeredAt:F.invalidTime},{...registered,registrationId:null},{...registered,deviceToken:F.token},
    {...registered,credentialHash:secret},
  ])('rejects contradictory or overexposed installation state: %j',value=>expect(installationDocumentSchema.safeParse(value).success).toBe(false));
  it('requires one exact registration shape and preserves a variable-length canonical token',()=>{
    expect(installationRegistrationSchema.parse(input)).toEqual(input);
  });
  it.each([
    {...input,expectedVersion:undefined},{...input,expectedVersion:F.version.negative},{...input,expectedVersion:F.version.fraction},
    {...input,expectedVersion:F.version.string},{...input,expectedVersion:F.version.maximum},{...input,registrationId:undefined},
    {...input,deviceToken:F.odd},{...input,deviceToken:F.upper},{...input,deviceToken:F.empty},{...input,userId:F.userId},
    {...input,installationId:F.installationId},{...input,secret},
  ])('rejects an ambiguous registration body before side effects: %j',value=>expect(installationRegistrationSchema.safeParse(value).success).toBe(false));
  it('requires a separate exact installation capability rather than bearer or array aliases',()=>{
    expect(installationProofSchema.parse(secret)).toBe(secret);
    expect(installationProofSchema.safeParse([secret]).success).toBe(false);
    expect(installationProofSchema.safeParse(F.secretPrefix+secret).success).toBe(false);
  });
  it('acknowledges only the detached target, without exposing the new association or version',()=>{
    const acknowledgement={installationId:F.installationId,associationId:F.associationId,detached:true};
    expect(installationDetachedSchema.parse(acknowledgement)).toEqual(acknowledgement);
    expect(installationDetachedSchema.safeParse({...acknowledgement,version:F.version.persisted}).success).toBe(false);
  });
});
describe('Installation controller account binding',()=>{
  function subject(){const repository={read:vi.fn(),register:vi.fn(),detach:vi.fn()};return {repository,controller:new NotificationInstallationsController(repository as unknown as DrizzleNotificationInstallationsRepository)};}
  it('does not reassign an old account path to a newly authenticated actor',()=>{
    const s=subject();
    try{s.controller.register(actor(),F.installationId,F.otherUserId,secret,input);throw new Error(I.failure.foreign.message);}
    catch(error){expect(error).toBeInstanceOf(HttpException);expect((error as HttpException).getStatus()).toBe(F.foreignStatus);}
    expect(s.repository.register).not.toHaveBeenCalled();
  });
  it('forwards the authenticated business user and exact capability/body',()=>{
    const s=subject();s.controller.register(actor(),F.installationId,F.userId.toUpperCase(),secret,input);
    expect(s.repository.register).toHaveBeenCalledExactlyOnceWith(F.userId,F.installationId,secret,input);
  });
  it('reads state for the current business account without a body-supplied actor',()=>{
    const s=subject();s.controller.read(actor(),F.installationId,secret);expect(s.repository.read).toHaveBeenCalledExactlyOnceWith(F.userId,F.installationId,secret);
  });
  it('forwards only the installation and association target for a capability-scoped detach',()=>{
    const s=subject();s.controller.detach(F.installationId,F.associationId,secret,{});expect(s.repository.detach).toHaveBeenCalledExactlyOnceWith(F.installationId,F.associationId,secret,{});
  });
});
