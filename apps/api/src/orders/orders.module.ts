import { Module } from '@nestjs/common';
import { FulfillmentModule } from '../fulfillment/fulfillment.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [FulfillmentModule],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
