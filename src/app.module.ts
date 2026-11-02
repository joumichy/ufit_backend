import {NotificationsModule} from './modules/notifications/notifications.module';
import { Module } from '@nestjs/common';
import { AdminModule } from './modules/admin/admin.module';
import { AdminAuditModule } from './modules/admin-audit/admin-audit.module';
import { ApplicationsModule } from './modules/applications/applications.module';
import { BrandsModule } from './modules/brands/brands.module';
import { CartModule } from './modules/cart/cart.module';
import { CommissionsModule } from './modules/commissions/commissions.module';
import { CreatorsModule } from './modules/creators/creators.module';
import { EditorialModule } from './modules/editorial/editorial.module';
import { HealthModule } from './modules/health/health.module';
import { IdentityModule } from './modules/identity/identity.module';
import { OrdersModule } from './modules/orders/orders.module';
import { OutfitsModule } from './modules/outfits/outfits.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { ProductsModule } from './modules/products/products.module';
import { SavedModule } from './modules/saved/saved.module';
import { ShippingModule } from './modules/shipping/shipping.module';
import { WorkspacesModule } from './modules/workspaces/workspaces.module';
import { DatabaseModule } from './shared/infrastructure/database/database.module';

@Module({
  imports: [
    DatabaseModule,
    NotificationsModule,
    HealthModule,
    IdentityModule,
    ProductsModule,
    OutfitsModule,
    EditorialModule,
    CreatorsModule,
    BrandsModule,
    ApplicationsModule,
    SavedModule,
    CartModule,
    OrdersModule,
    PaymentsModule,
    CommissionsModule,
    ShippingModule,
    AdminAuditModule,
    AdminModule,
    WorkspacesModule
  ]
})
export class AppModule {}
