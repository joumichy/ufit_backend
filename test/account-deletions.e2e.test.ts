import 'reflect-metadata';
import {BadRequestException,NotFoundException,UnauthorizedException,type INestApplication,ValidationPipe} from '@nestjs/common';
import {Test} from '@nestjs/testing';
import request from 'supertest';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ACCOUNT_DELETION as D,deletionIdentifierSchema,deletionProofSchema} from '../src/modules/identity/domain/account-deletion.contract';
import {AccountDeletionsController} from '../src/modules/identity/presentation/controllers/account-deletions.controller';
import {AccountDeletionService} from '../src/modules/identity/application/account-deletion.service';
import {DrizzleAccountDeletionRepository} from '../src/modules/identity/infrastructure/persistence/drizzle-account-deletion.repository';
import {DrizzleAccountDeletionQueue} from '../src/modules/identity/infrastructure/persistence/drizzle-account-deletion-queue';
import {AUTH_TOKEN_VERIFIER} from '../src/modules/identity/infrastructure/auth/auth-token-verifier';
import {SupabaseAccountDeletion} from '../src/modules/identity/infrastructure/auth/supabase-account-deletion';

const F={id:'d3c64191-415f-45a2-9882-7a0678877165',subject:'61ce4961-106d-47e1-aafd-8159519bc70b',
  proof:'ab'.repeat(32),wrong:'cd'.repeat(32),token:'qualification-token',path:'/account-deletions/',date:'2026-11-02T00:00:00.000Z',
  header:'Authorization',bearer:'Bearer ',cacheHeader:'cache-control',cache:'private, no-store',one:1,
  status:{ok:200,accepted:202,bad:400,unauthorized:401,missing:404,unavailable:503}} as const;
const receipt={requestId:F.id,phase:D.phase.purging,requestedAt:F.date,completedAt:null};

describe('Account deletion HTTP capability and actor binding',()=>{
 let app:INestApplication,stored=false;
 const verifier={verify:vi.fn()},authority={prepare:vi.fn()},requests={accept:vi.fn()},queue={lookup:vi.fn()};
 beforeEach(async()=>{
  stored=false;vi.resetAllMocks();
  queue.lookup.mockImplementation(async(id:string,proof:unknown)=>{
    const parsed=deletionIdentifierSchema.safeParse(id),key=deletionProofSchema.safeParse(proof);
    if(!parsed.success)throw new BadRequestException(D.failure.invalid);
    if(!key.success)throw new NotFoundException(D.failure.proof);
    if(parsed.data!==F.id||!stored)return null;
    if(key.data!==F.proof)throw new NotFoundException(D.failure.proof);
    return receipt;
  });
  verifier.verify.mockImplementation(async(token:string)=>{if(token!==F.token)throw new UnauthorizedException();return{sub:F.subject};});
  authority.prepare.mockResolvedValue(undefined);
  requests.accept.mockImplementation(async(subject:string,id:string,proof:string)=>{
    if(subject!==F.subject||id!==F.id||proof!==F.proof)throw new Error(D.failure.invalid.message);stored=true;return receipt;
  });
  const module=await Test.createTestingModule({controllers:[AccountDeletionsController],providers:[AccountDeletionService,
    {provide:DrizzleAccountDeletionRepository,useValue:requests},{provide:DrizzleAccountDeletionQueue,useValue:queue},
    {provide:AUTH_TOKEN_VERIFIER,useValue:verifier},{provide:SupabaseAccountDeletion,useValue:authority}]}).compile();
  app=module.createNestApplication();app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));await app.init();
 });
 afterEach(async()=>{await app.close();});
 function put(){return request(app.getHttpServer()).put(F.path+F.id).set(D.route.proofHeader,F.proof);}
 function authenticatedPut(){return put().set(F.header,F.bearer+F.token);}
 it('binds a new request to verified claims and returns a private pending receipt',async()=>{
  const response=await authenticatedPut().send({confirmed:true}).expect(F.status.accepted);
  expect(response.body).toEqual(receipt);expect(response.headers[F.cacheHeader]).toBe(F.cache);
  expect(verifier.verify).toHaveBeenCalledExactlyOnceWith(F.token);expect(authority.prepare).toHaveBeenCalledExactlyOnceWith(F.subject);
  expect(requests.accept).toHaveBeenCalledExactlyOnceWith(F.subject,F.id,F.proof);
 });
 it('requires authentication for a new command',async()=>{
  await put().send({confirmed:true}).expect(F.status.unauthorized);expect(requests.accept).not.toHaveBeenCalled();expect(authority.prepare).not.toHaveBeenCalled();
 });
 it('refuses an unverified bearer before closing the business account',async()=>{
  await put().set(F.header,F.bearer+F.wrong).send({confirmed:true}).expect(F.status.unauthorized);expect(requests.accept).not.toHaveBeenCalled();
 });
 it.each([{confirmed:false},{},{confirmed:true,userId:F.subject},{confirmed:true,authUserId:F.subject},{confirmed:true,proof:F.proof}])('rejects an ambiguous body before authority checks',async body=>{
  await authenticatedPut().send(body).expect(F.status.bad);expect(queue.lookup).not.toHaveBeenCalled();expect(requests.accept).not.toHaveBeenCalled();
 });
 it('does not close the account if the revocation authority is unavailable',async()=>{
  authority.prepare.mockRejectedValue(new Error(D.failure.authority.message));
  await authenticatedPut().send({confirmed:true}).expect(F.status.unavailable);expect(requests.accept).not.toHaveBeenCalled();expect(stored).toBe(false);
 });
 it('reads the accepted receipt after authentication has gone without reauthorizing deletion',async()=>{
  await authenticatedPut().send({confirmed:true}).expect(F.status.accepted);
  const response=await request(app.getHttpServer()).get(F.path+F.id).set(D.route.proofHeader,F.proof).expect(F.status.ok);
  expect(response.body).toEqual(receipt);expect(response.headers[F.cacheHeader]).toBe(F.cache);expect(requests.accept).toHaveBeenCalledTimes(F.one);
 });
 it('recovers a lost acknowledgement by replaying the capability without a second closure',async()=>{
  await authenticatedPut().send({confirmed:true}).expect(F.status.accepted);
  await put().send({confirmed:true}).expect(F.status.accepted);
  expect(requests.accept).toHaveBeenCalledTimes(F.one);expect(verifier.verify).toHaveBeenCalledTimes(F.one);expect(authority.prepare).toHaveBeenCalledTimes(F.one);
 });
 it('does not reveal or adopt a receipt with another capability',async()=>{
  stored=true;await request(app.getHttpServer()).get(F.path+F.id).set(D.route.proofHeader,F.wrong).expect(F.status.missing);
  await request(app.getHttpServer()).put(F.path+F.id).set(D.route.proofHeader,F.wrong).set(F.header,F.bearer+F.token).send({confirmed:true}).expect(F.status.missing);
  expect(requests.accept).not.toHaveBeenCalled();expect(verifier.verify).not.toHaveBeenCalled();
 });
 it('does not invent a pending receipt for an unknown command',async()=>{
  await request(app.getHttpServer()).get(F.path+F.id).set(D.route.proofHeader,F.proof).expect(F.status.missing);
  expect(requests.accept).not.toHaveBeenCalled();expect(stored).toBe(false);
 });
});
