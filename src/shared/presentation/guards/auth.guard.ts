import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { IdentityService } from '../../../modules/identity/application/identity.service';
import {
  AUTH_TOKEN_VERIFIER,
  type AuthTokenVerifier
} from '../../../modules/identity/infrastructure/auth/auth-token-verifier';
import type { RequestWithCurrentUser } from '../decorators/current-user.decorator';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(AUTH_TOKEN_VERIFIER)
    private readonly verifier: AuthTokenVerifier,
    @Inject(IdentityService) private readonly identityService: IdentityService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithCurrentUser>();
    const token = this.extractBearerToken(request);
    const claims = await this.verifier.verify(token);
    request.currentUser = await this.identityService.resolveCurrentUser(claims);
    return true;
  }

  private extractBearerToken(request: RequestWithCurrentUser): string {
    const header = request.headers.authorization;

    if (!header || Array.isArray(header)) {
      throw new UnauthorizedException('Missing bearer token');
    }

    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException('Invalid authorization header');
    }

    return token;
  }
}
