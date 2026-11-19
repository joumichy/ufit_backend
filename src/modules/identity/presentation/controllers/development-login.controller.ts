import {Controller, Get, Header, Inject} from '@nestjs/common';
import {DevelopmentLoginService} from '../../application/development-login.service';
import {DEVELOPMENT_LOGIN as D} from '../../domain/development-login.contract';

@Controller(D.route)
export class DevelopmentLoginController {
  constructor(@Inject(DevelopmentLoginService) private readonly login: DevelopmentLoginService) {}

  @Get(D.alias)
  @Header(D.response.cacheHeader, D.response.cachePolicy)
  resolve() {
    return this.login.resolve();
  }
}
