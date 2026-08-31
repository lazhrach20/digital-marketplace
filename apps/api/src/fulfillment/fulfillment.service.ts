import { Injectable, NotImplementedException } from '@nestjs/common';

/** Layer 4 orchestrator entry points — stub until fulfillment is wired. */
@Injectable()
export class FulfillmentService {
  async startForPaidOrder(orderId: string): Promise<void> {
    throw new NotImplementedException(
      `startForPaidOrder is not implemented yet (${orderId})`,
    );
  }

  async retryDelivery(orderId: string): Promise<void> {
    throw new NotImplementedException(
      `retryDelivery is not implemented yet (${orderId})`,
    );
  }
}
