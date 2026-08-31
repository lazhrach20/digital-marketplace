import { Module } from '@nestjs/common';
import { CatalogModule } from './catalog/catalog.module';
import { FulfillmentModule } from './fulfillment/fulfillment.module';
import { OrdersModule } from './orders/orders.module';
import { PaymentsModule } from './payments/payments.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    PrismaModule,
    CatalogModule,
    OrdersModule,
    PaymentsModule,
    FulfillmentModule,
  ],
})
export class AppModule {}

