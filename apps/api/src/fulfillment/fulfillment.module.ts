import { Module } from '@nestjs/common';
import { FulfillmentService } from './fulfillment.service';
import { InventoryService } from './inventory.service';
import { ProviderAAdapter } from './provider-a.adapter';
import { ProviderRequestStore } from './provider-request.store';

@Module({
  providers: [
    FulfillmentService,
    InventoryService,
    ProviderRequestStore,
    ProviderAAdapter,
  ],
  exports: [
    FulfillmentService,
    InventoryService,
    ProviderRequestStore,
    ProviderAAdapter,
  ],
})
export class FulfillmentModule {}

