import { BrandsModule } from "../brands/brands.module";
import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../shared/infrastructure/database/database.module";
import { IdentityModule } from "../identity/identity.module";
import { ShippingService } from "./application/shipping.service";
import { DrizzleShipmentRepository } from "./infrastructure/drizzle-shipping.repository";
import { InMemoryShipmentRepository } from "./infrastructure/in-memory-shipping.repository";
import { ShippingController } from "./presentation/shipping.controller";

@Module({
  imports: [DatabaseModule, IdentityModule, BrandsModule],
  controllers: [ShippingController],
  providers: [
    ShippingService,
    { provide: "ShipmentRepository", useExisting: DrizzleShipmentRepository },
    DrizzleShipmentRepository,
    InMemoryShipmentRepository,
  ],
  exports: [ShippingService],
})
export class ShippingModule {}
