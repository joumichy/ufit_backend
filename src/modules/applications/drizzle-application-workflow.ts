import { Inject, Injectable } from "@nestjs/common";
import { DatabaseService } from "../../shared/infrastructure/database/database.service";
import type { DatabaseSession } from "../../shared/infrastructure/database/database-session";
import { DrizzleCreatorsRepository } from "../creators/drizzle-creators.repository";
import { CreatorsService } from "../creators/creators.service";
import { DrizzleBrandsRepository } from "../brands/drizzle-brands.repository";
import { BrandsService } from "../brands/brands.service";
import { DrizzleIdentityRepository } from "../identity/infrastructure/persistence/drizzle-identity.repository";
import { DrizzleApplicationsRepository } from "./drizzle-applications.repository";
import type { ApplicationWorkflow, ApplicationWorkflowContext } from "./types/application.types";

@Injectable()
export class DrizzleApplicationWorkflow implements ApplicationWorkflow {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}
  run<T>(operation: (context: ApplicationWorkflowContext) => Promise<T>): Promise<T> {
    return this.database.db.transaction(async tx => {
      const session: DatabaseSession = {db: tx};
      const creators = new CreatorsService(new DrizzleCreatorsRepository(session));
      const brands = new BrandsService(new DrizzleBrandsRepository(session));
      return operation({applications: new DrizzleApplicationsRepository(session),
        identity: new DrizzleIdentityRepository(session),
        provisioning: {provisionCreatorFromApplication: application => creators.provisionFromApplication(application),
          provisionBrandFromApplication: application => brands.provisionFromApplication(application)}});
    });
  }
}
