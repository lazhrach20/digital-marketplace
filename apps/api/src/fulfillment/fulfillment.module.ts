import { Module } from '@nestjs/common';
import { FulfillmentService } from './fulfillment.service';
import { InventoryService } from './inventory.service';

@Module({
  providers: [FulfillmentService, InventoryService],
  exports: [FulfillmentService, InventoryService],
})
export class FulfillmentModule {}
