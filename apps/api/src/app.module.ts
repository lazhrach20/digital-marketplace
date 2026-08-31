import { Module } from '@nestjs/common';
import { CatalogModule } from './catalog/catalog.module';
import { OrdersModule } from './orders/orders.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [PrismaModule, CatalogModule, OrdersModule],
})
export class AppModule {}

