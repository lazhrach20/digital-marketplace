import { Module } from '@nestjs/common';
import { FulfillmentService } from './fulfillment.service';
import { InventoryService } from './inventory.service';
import { ProviderAAdapter } from './provider-a.adapter';
import { ProviderBAdapter } from './provider-b.adapter';
import { ProviderRequestStore } from './provider-request.store';

@Module({
  providers: [
    FulfillmentService,
    InventoryService,
    ProviderRequestStore,
    ProviderAAdapter,
    ProviderBAdapter,
  ],
  exports: [
    FulfillmentService,
    InventoryService,
    ProviderRequestStore,
    ProviderAAdapter,
    ProviderBAdapter,
  ],
})
export class FulfillmentModule {}

