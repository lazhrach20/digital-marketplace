import { Module } from '@nestjs/common';
import { FulfillmentModule } from '../fulfillment/fulfillment.module';
import { PaymentsService } from './payments.service';

@Module({
  imports: [FulfillmentModule],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
