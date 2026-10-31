import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { AuthGuard } from "../../../shared/presentation/guards/auth.guard";
import { CurrentUser } from "../../../shared/presentation/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../../identity/domain/user.types";
import { ConnectAccountsService } from "../application/connect-accounts.service";
import { CONNECT, type ConnectKind } from "../domain/connect-account";

@Controller(CONNECT.route.base)
export class ConnectAccountsController {
  constructor(
    @Inject(ConnectAccountsService)
    private readonly accounts: ConnectAccountsService,
  ) {}
  @Get(CONNECT.route.returned)
  returned(@Res() response: Response) {
    response.redirect(CONNECT.callback.redirect, CONNECT.callback.appReturn);
  }
  @Get(CONNECT.route.refresh)
  refresh(@Res() response: Response) {
    response.redirect(CONNECT.callback.redirect, CONNECT.callback.appRefresh);
  }
  @Get(CONNECT.route.countries)
  @UseGuards(AuthGuard)
  countries() {
    return this.accounts.countries();
  }
  @Get(CONNECT.route.status)
  @UseGuards(AuthGuard)
  status(
    @Param(CONNECT.route.kindParam) kind: string,
    @Param(CONNECT.route.profileParam, ParseUUIDPipe) profileId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.accounts.status({ kind: this.kind(kind), profileId }, actor);
  }
  @Post(CONNECT.route.onboarding)
  @UseGuards(AuthGuard)
  onboarding(
    @Param(CONNECT.route.kindParam) kind: string,
    @Param(CONNECT.route.profileParam, ParseUUIDPipe) profileId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Body() raw: unknown,
  ) {
    return this.accounts.onboarding(
      { kind: this.kind(kind), profileId },
      actor,
      raw,
    );
  }
  @Post(CONNECT.route.dashboard)
  @UseGuards(AuthGuard)
  dashboard(
    @Param(CONNECT.route.kindParam) kind: string,
    @Param(CONNECT.route.profileParam, ParseUUIDPipe) profileId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.accounts.dashboard({ kind: this.kind(kind), profileId }, actor);
  }
  private kind(kind: string): ConnectKind {
    if (kind !== CONNECT.kind.brand && kind !== CONNECT.kind.creator)
      throw new BadRequestException(CONNECT.failure.scope);
    return kind;
  }
}
