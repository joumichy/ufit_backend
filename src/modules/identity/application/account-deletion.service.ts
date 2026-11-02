import {BadRequestException,Inject,Injectable,NotFoundException,ServiceUnavailableException,UnauthorizedException} from '@nestjs/common';
import {ACCOUNT_DELETION as D,deletionBearerSchema,deletionInputSchema,type AccountDeletionReceipt} from '../domain/account-deletion.contract';
import {AUTH_TOKEN_VERIFIER,type AuthTokenVerifier} from '../infrastructure/auth/auth-token-verifier';
import {SupabaseAccountDeletion} from '../infrastructure/auth/supabase-account-deletion';
import {DrizzleAccountDeletionRepository} from '../infrastructure/persistence/drizzle-account-deletion.repository';
import {DrizzleAccountDeletionQueue} from '../infrastructure/persistence/drizzle-account-deletion-queue';

@Injectable()
export class AccountDeletionService {
  constructor(@Inject(DrizzleAccountDeletionRepository) private readonly requests:DrizzleAccountDeletionRepository,
    @Inject(DrizzleAccountDeletionQueue) private readonly queue:DrizzleAccountDeletionQueue,
    @Inject(AUTH_TOKEN_VERIFIER) private readonly verifier:AuthTokenVerifier,
    @Inject(SupabaseAccountDeletion) private readonly authority:Pick<SupabaseAccountDeletion,'prepare'>) {}

  async read(id:string,proof:unknown):Promise<AccountDeletionReceipt> {
    const receipt=await this.queue.lookup(id,proof);
    if(!receipt)throw new NotFoundException(D.failure.unavailable);
    return receipt;
  }
  async accept(id:string,proof:unknown,authorization:unknown,raw:unknown):Promise<AccountDeletionReceipt> {
    if(!deletionInputSchema.safeParse(raw).success)throw new BadRequestException(D.failure.invalid);
    const previous=await this.queue.lookup(id,proof);
    if(previous)return previous;
    const bearer=deletionBearerSchema.safeParse(authorization);
    if(!bearer.success)throw new UnauthorizedException(D.failure.unavailable);
    const claims=await this.verifier.verify(bearer.data);
    try {await this.authority.prepare(claims.sub);}catch {throw new ServiceUnavailableException(D.failure.authority);}
    return this.requests.accept(claims.sub,id,proof);
  }
}
