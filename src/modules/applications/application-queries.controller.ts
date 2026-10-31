import { APPLICATION_COUNTRIES } from "./application-countries";
import { BadRequestException, Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Query, UseGuards } from "@nestjs/common";
import { AuthGuard } from "../../shared/presentation/guards/auth.guard";
import { AdminGuard } from "../../shared/presentation/guards/admin.guard";
import { CurrentUser } from "../../shared/presentation/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../identity/domain/user.types";
import { ApplicationsService } from "./applications.service";
import { DrizzleApplicationReader } from "./drizzle-application-reader";
import { APPLICATION, type ApplicationKind } from "./types/application-contract";
import { ResubmitBrandApplicationRequest, ResubmitCreatorApplicationRequest } from "./dto/resubmit-application.request";
const ROUTE = {countries: "applications/countries", current: "applications/me", owned: "applications/:collection/:id", creatorCorrection: "applications/creators/:id", brandCorrection: "applications/brands/:id", queue: "admin/applications", adminDetail: "admin/applications/:kind/:id", id: "id", collection: "collection", kind: "kind"} as const;
@Controller()
@UseGuards(AuthGuard)
export class ApplicationQueriesController {
  constructor(@Inject(ApplicationsService) private readonly applications: ApplicationsService,
    @Inject(DrizzleApplicationReader) private readonly reader: DrizzleApplicationReader) {}
  @Get(ROUTE.countries)
  countries() { return {countries: APPLICATION_COUNTRIES}; }
  @Get(ROUTE.current)
  current(@CurrentUser() user: AuthenticatedUser) { return this.reader.current(user.id); }
  @Get(ROUTE.owned)
  owned(@CurrentUser() user: AuthenticatedUser, @Param(ROUTE.collection) collection: string, @Param(ROUTE.id, ParseUUIDPipe) id: string) {
    return this.reader.owned(this.collection(collection), id, user.id);
  }
  @Patch(ROUTE.creatorCorrection)
  async creatorCorrection(@CurrentUser() user: AuthenticatedUser, @Param(ROUTE.id, ParseUUIDPipe) id: string, @Body() body: ResubmitCreatorApplicationRequest) {
    const {expectedVersion, ...fields} = body;
    await this.applications.resubmitCreatorApplication(id, {...fields, userId: user.id}, expectedVersion);
    return this.reader.owned(APPLICATION.kind.creator, id, user.id);
  }
  @Patch(ROUTE.brandCorrection)
  async brandCorrection(@CurrentUser() user: AuthenticatedUser, @Param(ROUTE.id, ParseUUIDPipe) id: string, @Body() body: ResubmitBrandApplicationRequest) {
    const {expectedVersion, ...fields} = body;
    await this.applications.resubmitBrandApplication(id, {...fields, userId: user.id}, expectedVersion);
    return this.reader.owned(APPLICATION.kind.brand, id, user.id);
  }
  @Get(ROUTE.queue)
  @UseGuards(AdminGuard)
  queue(@Query() input: unknown) { return this.reader.queue(input); }
  @Get(ROUTE.adminDetail)
  @UseGuards(AdminGuard)
  adminDetail(@Param(ROUTE.kind) kind: string, @Param(ROUTE.id, ParseUUIDPipe) id: string) {
    if (kind !== APPLICATION.kind.creator && kind !== APPLICATION.kind.brand) throw new BadRequestException(APPLICATION.failure.notFound);
    return this.reader.admin(kind, id);
  }
  private collection(value: string): ApplicationKind {
    if (value === APPLICATION.collection.creator) return APPLICATION.kind.creator;
    if (value === APPLICATION.collection.brand) return APPLICATION.kind.brand;
    throw new BadRequestException(APPLICATION.failure.notFound);
  }
}
